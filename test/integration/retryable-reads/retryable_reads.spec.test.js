const { expect } = require('chai');
const path = require('path');
const semver = require('semver');
const { TestRunnerContext, generateTopologyTests } = require('../../tools/spec-runner');
const { loadSpecTests } = require('../../spec');
const { runUnifiedSuite } = require('../../tools/unified-spec-runner/runner');
const { TopologyType } = require('../../../src');

const VALID_TOPOLOGIES = [
  TopologyType.ReplicaSetWithPrimary,
  TopologyType.Sharded,
  TopologyType.LoadBalanced
];

describe('Retryable Reads (legacy)', function () {
  const testContext = new TestRunnerContext();
  const testSuites = loadSpecTests(path.join('retryable-reads', 'legacy'));

  after(() => testContext.teardown());
  before(function () {
    return testContext.setup(this.configuration);
  });

  generateTopologyTests(testSuites, testContext, spec => {
    return (
      spec.description.match(/distinct/i) ||
      spec.description.match(/aggregate/i) ||
      spec.description.match(/countDocuments/i) ||
      spec.description.match(/listIndexes/i) ||
      spec.description.match(/listDatabases/i) ||
      spec.description.match(/listDatabaseNames/i) ||
      spec.description.match(/listCollections/i) ||
      spec.description.match(/listCollectionNames/i) ||
      spec.description.match(/estimatedDocumentCount/i) ||
      spec.description.match(/count/i) ||
      spec.description.match(/find/i)
    );
  });
});

// These tests are skipped because the driver 1) executes a ping when connecting to
// an authenticated server and 2) command monitoring is at the connection level so
// when the handshake fails no command started event is emitted.
const SKIP = [
  'find succeeds after retryable handshake network error',
  'find succeeds after retryable handshake network error (ShutdownInProgress)'
];

describe('Retryable Reads (unified)', function () {
  runUnifiedSuite(loadSpecTests(path.join('retryable-reads', 'unified')), SKIP);
});

describe('Retryable Reads Spec Manual Tests', function () {
  const dbName = 'retryable-handshake-tests';
  const collName = 'coll';
  const docs = [
    { _id: 1, x: 11 },
    { _id: 2, x: 22 },
    { _id: 3, x: 33 }
  ];
  let client;
  let db;
  let coll;

  beforeEach(async function () {
    if (
      semver.lt(this.configuration.buildInfo.version, '4.2.0') ||
      !VALID_TOPOLOGIES.includes(this.configuration.topologyType) ||
      !this.configuration.options.auth ||
      !!process.env.SERVERLESS
    ) {
      this.currentTest.skipReason =
        'Retryable reads tests requires authenticated MongoDB 4.2 and higher and no standalone';
      this.skip();
    }
    client = this.configuration.newClient({});
    db = client.db(dbName);
    coll = db.collection(collName);
    await client.connect();
    await coll.insertMany(docs);
  });

  afterEach(async function () {
    if (db) {
      await db.admin().command({
        configureFailPoint: 'failCommand',
        mode: 'off'
      });
      await coll.drop();
      await client.close();
    }
  });

  context('when the handshake fails with a network error', function () {
    // Manual implementation for: 'find succeeds after retryable handshake network error'
    it('retries the read', async function () {
      await db.admin().command({
        configureFailPoint: 'failCommand',
        mode: { times: 2 },
        data: {
          failCommands: ['saslContinue', 'ping'],
          closeConnection: true
        }
      });
      const doc = await coll.findOne({ _id: 2 });
      expect(doc).to.deep.equal(docs[1]);
    });
  });

  context('when the handshake fails with shutdown in progress', function () {
    // Manual implementation for:
    // 'find succeeds after retryable handshake network error (ShutdownInProgress)'
    it('retries the read', async function () {
      await db.admin().command({
        configureFailPoint: 'failCommand',
        mode: { times: 2 },
        data: {
          failCommands: ['saslContinue', 'ping'],
          errorCode: 91 // ShutdownInProgress
        }
      });
      const documents = await coll.find().toArray();
      expect(documents).to.deep.equal(docs);
    });
  });
});
