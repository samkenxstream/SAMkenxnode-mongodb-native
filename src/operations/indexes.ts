import type { Document } from '../bson';
import type { Collection } from '../collection';
import type { Db } from '../db';
import { MongoCompatibilityError, MONGODB_ERROR_CODES, MongoError } from '../error';
import type { OneOrMore } from '../mongo_types';
import { ReadPreference } from '../read_preference';
import type { Server } from '../sdam/server';
import type { ClientSession } from '../sessions';
import { type Callback, isObject, maxWireVersion, type MongoDBNamespace } from '../utils';
import {
  type CollationOptions,
  CommandOperation,
  type CommandOperationOptions,
  type OperationParent
} from './command';
import { indexInformation, type IndexInformationOptions } from './common_functions';
import { AbstractOperation, Aspect, defineAspects } from './operation';

const VALID_INDEX_OPTIONS = new Set([
  'background',
  'unique',
  'name',
  'partialFilterExpression',
  'sparse',
  'hidden',
  'expireAfterSeconds',
  'storageEngine',
  'collation',
  'version',

  // text indexes
  'weights',
  'default_language',
  'language_override',
  'textIndexVersion',

  // 2d-sphere indexes
  '2dsphereIndexVersion',

  // 2d indexes
  'bits',
  'min',
  'max',

  // geoHaystack Indexes
  'bucketSize',

  // wildcard indexes
  'wildcardProjection'
]);

/** @public */
export type IndexDirection =
  | -1
  | 1
  | '2d'
  | '2dsphere'
  | 'text'
  | 'geoHaystack'
  | 'hashed'
  | number;

function isIndexDirection(x: unknown): x is IndexDirection {
  return (
    typeof x === 'number' || x === '2d' || x === '2dsphere' || x === 'text' || x === 'geoHaystack'
  );
}
/** @public */
export type IndexSpecification = OneOrMore<
  | string
  | [string, IndexDirection]
  | { [key: string]: IndexDirection }
  | Map<string, IndexDirection>
>;

/** @public */
export interface IndexDescription
  extends Pick<
    CreateIndexesOptions,
    | 'background'
    | 'unique'
    | 'partialFilterExpression'
    | 'sparse'
    | 'hidden'
    | 'expireAfterSeconds'
    | 'storageEngine'
    | 'version'
    | 'weights'
    | 'default_language'
    | 'language_override'
    | 'textIndexVersion'
    | '2dsphereIndexVersion'
    | 'bits'
    | 'min'
    | 'max'
    | 'bucketSize'
    | 'wildcardProjection'
  > {
  collation?: CollationOptions;
  name?: string;
  key: { [key: string]: IndexDirection } | Map<string, IndexDirection>;
}

/** @public */
export interface CreateIndexesOptions extends Omit<CommandOperationOptions, 'writeConcern'> {
  /** Creates the index in the background, yielding whenever possible. */
  background?: boolean;
  /** Creates an unique index. */
  unique?: boolean;
  /** Override the autogenerated index name (useful if the resulting name is larger than 128 bytes) */
  name?: string;
  /** Creates a partial index based on the given filter object (MongoDB 3.2 or higher) */
  partialFilterExpression?: Document;
  /** Creates a sparse index. */
  sparse?: boolean;
  /** Allows you to expire data on indexes applied to a data (MongoDB 2.2 or higher) */
  expireAfterSeconds?: number;
  /** Allows users to configure the storage engine on a per-index basis when creating an index. (MongoDB 3.0 or higher) */
  storageEngine?: Document;
  /** (MongoDB 4.4. or higher) Specifies how many data-bearing members of a replica set, including the primary, must complete the index builds successfully before the primary marks the indexes as ready. This option accepts the same values for the "w" field in a write concern plus "votingMembers", which indicates all voting data-bearing nodes. */
  commitQuorum?: number | string;
  /** Specifies the index version number, either 0 or 1. */
  version?: number;
  // text indexes
  weights?: Document;
  default_language?: string;
  language_override?: string;
  textIndexVersion?: number;
  // 2d-sphere indexes
  '2dsphereIndexVersion'?: number;
  // 2d indexes
  bits?: number;
  /** For geospatial indexes set the lower bound for the co-ordinates. */
  min?: number;
  /** For geospatial indexes set the high bound for the co-ordinates. */
  max?: number;
  // geoHaystack Indexes
  bucketSize?: number;
  // wildcard indexes
  wildcardProjection?: Document;
  /** Specifies that the index should exist on the target collection but should not be used by the query planner when executing operations. (MongoDB 4.4 or higher) */
  hidden?: boolean;
}

function isSingleIndexTuple(t: unknown): t is [string, IndexDirection] {
  return Array.isArray(t) && t.length === 2 && isIndexDirection(t[1]);
}

function makeIndexSpec(
  indexSpec: IndexSpecification,
  options?: CreateIndexesOptions
): IndexDescription {
  const key: Map<string, IndexDirection> = new Map();

  const indexSpecs =
    !Array.isArray(indexSpec) || isSingleIndexTuple(indexSpec) ? [indexSpec] : indexSpec;

  // Iterate through array and handle different types
  for (const spec of indexSpecs) {
    if (typeof spec === 'string') {
      key.set(spec, 1);
    } else if (Array.isArray(spec)) {
      key.set(spec[0], spec[1] ?? 1);
    } else if (spec instanceof Map) {
      for (const [property, value] of spec) {
        key.set(property, value);
      }
    } else if (isObject(spec)) {
      for (const [property, value] of Object.entries(spec)) {
        key.set(property, value);
      }
    }
  }

  return { ...options, key };
}

/** @internal */
export class IndexesOperation extends AbstractOperation<Document[]> {
  override options: IndexInformationOptions;
  collection: Collection;

  constructor(collection: Collection, options: IndexInformationOptions) {
    super(options);
    this.options = options;
    this.collection = collection;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<Document[]>
  ): void {
    const coll = this.collection;
    const options = this.options;

    indexInformation(
      coll.s.db,
      coll.collectionName,
      { full: true, ...options, readPreference: this.readPreference, session },
      callback
    );
  }
}

/** @internal */
export class CreateIndexesOperation<
  T extends string | string[] = string[]
> extends CommandOperation<T> {
  override options: CreateIndexesOptions;
  collectionName: string;
  indexes: ReadonlyArray<Omit<IndexDescription, 'key'> & { key: Map<string, IndexDirection> }>;

  constructor(
    parent: OperationParent,
    collectionName: string,
    indexes: IndexDescription[],
    options?: CreateIndexesOptions
  ) {
    super(parent, options);

    this.options = options ?? {};
    this.collectionName = collectionName;
    this.indexes = indexes.map(userIndex => {
      // Ensure the key is a Map to preserve index key ordering
      const key =
        userIndex.key instanceof Map ? userIndex.key : new Map(Object.entries(userIndex.key));
      const name = userIndex.name != null ? userIndex.name : Array.from(key).flat().join('_');
      const validIndexOptions = Object.fromEntries(
        Object.entries({ ...userIndex }).filter(([optionName]) =>
          VALID_INDEX_OPTIONS.has(optionName)
        )
      );
      return {
        ...validIndexOptions,
        name,
        key
      };
    });
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<T>
  ): void {
    const options = this.options;
    const indexes = this.indexes;

    const serverWireVersion = maxWireVersion(server);

    const cmd: Document = { createIndexes: this.collectionName, indexes };

    if (options.commitQuorum != null) {
      if (serverWireVersion < 9) {
        callback(
          new MongoCompatibilityError(
            'Option `commitQuorum` for `createIndexes` not supported on servers < 4.4'
          )
        );
        return;
      }
      cmd.commitQuorum = options.commitQuorum;
    }

    // collation is set on each index, it should not be defined at the root
    this.options.collation = undefined;

    super.executeCommand(server, session, cmd, err => {
      if (err) {
        callback(err);
        return;
      }

      const indexNames = indexes.map(index => index.name || '');
      callback(undefined, indexNames as T);
    });
  }
}

/** @internal */
export class CreateIndexOperation extends CreateIndexesOperation<string> {
  constructor(
    parent: OperationParent,
    collectionName: string,
    indexSpec: IndexSpecification,
    options?: CreateIndexesOptions
  ) {
    super(parent, collectionName, [makeIndexSpec(indexSpec, options)], options);
  }
  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<string>
  ): void {
    super.execute(server, session, (err, indexNames) => {
      if (err || !indexNames) return callback(err);
      return callback(undefined, indexNames[0]);
    });
  }
}

/** @internal */
export class EnsureIndexOperation extends CreateIndexOperation {
  db: Db;

  constructor(
    db: Db,
    collectionName: string,
    indexSpec: IndexSpecification,
    options?: CreateIndexesOptions
  ) {
    super(db, collectionName, indexSpec, options);

    this.readPreference = ReadPreference.primary;
    this.db = db;
    this.collectionName = collectionName;
  }

  override execute(server: Server, session: ClientSession | undefined, callback: Callback): void {
    const indexName = this.indexes[0].name;
    const cursor = this.db.collection(this.collectionName).listIndexes({ session });
    cursor.toArray().then(
      indexes => {
        indexes = Array.isArray(indexes) ? indexes : [indexes];
        if (indexes.some(index => index.name === indexName)) {
          callback(undefined, indexName);
          return;
        }
        super.execute(server, session, callback);
      },
      error => {
        if (error instanceof MongoError && error.code === MONGODB_ERROR_CODES.NamespaceNotFound) {
          // ignore "NamespaceNotFound" errors
          return super.execute(server, session, callback);
        }
        return callback(error);
      }
    );
  }
}

/** @public */
export type DropIndexesOptions = CommandOperationOptions;

/** @internal */
export class DropIndexOperation extends CommandOperation<Document> {
  override options: DropIndexesOptions;
  collection: Collection;
  indexName: string;

  constructor(collection: Collection, indexName: string, options?: DropIndexesOptions) {
    super(collection, options);

    this.options = options ?? {};
    this.collection = collection;
    this.indexName = indexName;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<Document>
  ): void {
    const cmd = { dropIndexes: this.collection.collectionName, index: this.indexName };
    super.executeCommand(server, session, cmd, callback);
  }
}

/** @internal */
export class DropIndexesOperation extends DropIndexOperation {
  constructor(collection: Collection, options: DropIndexesOptions) {
    super(collection, '*', options);
  }

  override execute(server: Server, session: ClientSession | undefined, callback: Callback): void {
    super.execute(server, session, err => {
      if (err) return callback(err, false);
      callback(undefined, true);
    });
  }
}

/** @public */
export interface ListIndexesOptions extends Omit<CommandOperationOptions, 'writeConcern'> {
  /** The batchSize for the returned command cursor or if pre 2.8 the systems batch collection */
  batchSize?: number;
}

/** @internal */
export class ListIndexesOperation extends CommandOperation<Document> {
  /**
   * @remarks WriteConcern can still be present on the options because
   * we inherit options from the client/db/collection.  The
   * key must be present on the options in order to delete it.
   * This allows typescript to delete the key but will
   * not allow a writeConcern to be assigned as a property on options.
   */
  override options: ListIndexesOptions & { writeConcern?: never };
  collectionNamespace: MongoDBNamespace;

  constructor(collection: Collection, options?: ListIndexesOptions) {
    super(collection, options);

    this.options = { ...options };
    delete this.options.writeConcern;
    this.collectionNamespace = collection.s.namespace;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<Document>
  ): void {
    const serverWireVersion = maxWireVersion(server);

    const cursor = this.options.batchSize ? { batchSize: this.options.batchSize } : {};

    const command: Document = { listIndexes: this.collectionNamespace.collection, cursor };

    // we check for undefined specifically here to allow falsy values
    // eslint-disable-next-line no-restricted-syntax
    if (serverWireVersion >= 9 && this.options.comment !== undefined) {
      command.comment = this.options.comment;
    }

    super.executeCommand(server, session, command, callback);
  }
}

/** @internal */
export class IndexExistsOperation extends AbstractOperation<boolean> {
  override options: IndexInformationOptions;
  collection: Collection;
  indexes: string | string[];

  constructor(
    collection: Collection,
    indexes: string | string[],
    options: IndexInformationOptions
  ) {
    super(options);
    this.options = options;
    this.collection = collection;
    this.indexes = indexes;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<boolean>
  ): void {
    const coll = this.collection;
    const indexes = this.indexes;

    indexInformation(
      coll.s.db,
      coll.collectionName,
      { ...this.options, readPreference: this.readPreference, session },
      (err, indexInformation) => {
        // If we have an error return
        if (err != null) return callback(err);
        // Let's check for the index names
        if (!Array.isArray(indexes)) return callback(undefined, indexInformation[indexes] != null);
        // Check in list of indexes
        for (let i = 0; i < indexes.length; i++) {
          if (indexInformation[indexes[i]] == null) {
            return callback(undefined, false);
          }
        }

        // All keys found return true
        return callback(undefined, true);
      }
    );
  }
}

/** @internal */
export class IndexInformationOperation extends AbstractOperation<Document> {
  override options: IndexInformationOptions;
  db: Db;
  name: string;

  constructor(db: Db, name: string, options?: IndexInformationOptions) {
    super(options);
    this.options = options ?? {};
    this.db = db;
    this.name = name;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<Document>
  ): void {
    const db = this.db;
    const name = this.name;

    indexInformation(
      db,
      name,
      { ...this.options, readPreference: this.readPreference, session },
      callback
    );
  }
}

defineAspects(ListIndexesOperation, [
  Aspect.READ_OPERATION,
  Aspect.RETRYABLE,
  Aspect.CURSOR_CREATING
]);
defineAspects(CreateIndexesOperation, [Aspect.WRITE_OPERATION]);
defineAspects(CreateIndexOperation, [Aspect.WRITE_OPERATION]);
defineAspects(EnsureIndexOperation, [Aspect.WRITE_OPERATION]);
defineAspects(DropIndexOperation, [Aspect.WRITE_OPERATION]);
defineAspects(DropIndexesOperation, [Aspect.WRITE_OPERATION]);
