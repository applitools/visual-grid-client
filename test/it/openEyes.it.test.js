'use strict';
const {describe, it, before, after, beforeEach, afterEach} = require('mocha');
const {expect} = require('chai');
const makeRenderingGridClient = require('../../src/sdk/renderingGridClient');
const FakeEyesWrapper = require('../util/FakeEyesWrapper');
const FakeRunningRender = require('../util/FakeRunningRender');
const createFakeWrapper = require('../util/createFakeWrapper');
const testServer = require('../util/testServer');
const {loadJsonFixture, loadFixtureBuffer} = require('../util/loadFixture');
const {promisify: p} = require('util');
const nock = require('nock');
const psetTimeout = p(setTimeout);
const {presult} = require('@applitools/functional-commons');
const {
  RenderStatus,
  RenderStatusResults,
  Region,
  IgnoreRegionByRectangle,
  FloatingRegionByRectangle,
  ProxySettings,
} = require('@applitools/eyes-sdk-core');
const {
  apiKeyFailMsg,
  authorizationErrMsg,
  appNameFailMsg,
  blockedAccountErrMsg,
  badRequestErrMsg,
} = require('../../src/sdk/wrapperUtils');

describe('openEyes', () => {
  let baseUrl, closeServer, wrapper, openEyes, prevEnv, APPLITOOLS_SHOW_LOGS;
  const apiKey = 'some api key';
  const appName = 'some app name';

  before(async () => {
    const server = await testServer({port: 3456}); // TODO fixed port avoids 'need-more-resources' for dom. Is this desired? should both paths be tested?
    baseUrl = `http://localhost:${server.port}`;
    closeServer = server.close;
  });

  after(async () => {
    await closeServer();
  });

  beforeEach(() => {
    APPLITOOLS_SHOW_LOGS = process.env.APPLITOOLS_SHOW_LOGS;
    prevEnv = process.env;
    process.env = {};

    wrapper = createFakeWrapper(baseUrl);

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
    }).openEyes;

    nock(wrapper.baseUrl)
      .persist()
      .post(wrapper.resultsRoute)
      .reply(201, (_url, body) => body, {
        location: (_req, _res, body) => body,
      });
  });

  afterEach(() => {
    process.env = prevEnv;
  });

  it("doesn't throw exception", async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    checkWindow({cdt: [], tag: 'good1', url: `${baseUrl}/test.html`});
    expect((await close())[0].map(r => r.getAsExpected())).to.eql([true]);
  });

  it('throws with bad tag', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });
    checkWindow({cdt: [], resourceUrls: [], tag: 'bad!', url: `${baseUrl}/test.html`});
    await psetTimeout(0); // because FakeEyesWrapper throws, and then the error is set async and will be read in the next call to close()
    expect((await presult(close()))[0].message).to.equal(
      `Tag bad! should be one of the good tags good1,good2`,
    );
  });

  it('passes with correct dom', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    const resourceUrls = wrapper.goodResourceUrls;
    const cdt = loadJsonFixture('test.cdt.json');
    checkWindow({resourceUrls, cdt, tag: 'good1', url: `${baseUrl}/test.html`});

    expect((await close())[0].map(r => r.getAsExpected())).to.eql([true]);
  });

  it('fails with incorrect dom', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });
    const resourceUrls = ['smurfs.jpg', 'test.css'];
    const cdt = loadJsonFixture('test.cdt.json');
    cdt.find(node => node.nodeValue === "hi, I'm red").nodeValue = "hi, I'm green";

    checkWindow({resourceUrls, cdt, tag: 'good1', url: `${baseUrl}/test.html`});

    expect((await presult(close()))[0].message).to.equal('mismatch');
  });

  it('renders multiple viewport sizes', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [
        createFakeWrapper(baseUrl),
        createFakeWrapper(baseUrl),
        createFakeWrapper(baseUrl),
      ],
      browser: [{width: 320, height: 480}, {width: 640, height: 768}, {width: 1600, height: 900}],
      appName,
    });

    const resourceUrls = wrapper.goodResourceUrls;
    const cdt = loadJsonFixture('test.cdt.json');
    checkWindow({resourceUrls, cdt, tag: 'good1', url: `${baseUrl}/test.html`});
    expect(
      (await close()).map(wrapperResult => wrapperResult.map(r2 => r2.getAsExpected())),
    ).to.eql([[true], [true], [true]]);
  });

  it('handles `batchName` and `batchId` param', async () => {
    const batchName = `some batch name ${Date.now()}`;
    const batchId = `some batch ID ${Date.now()}`;
    await openEyes({
      wrappers: [wrapper],
      batchName,
      batchId,
      appName,
    });

    expect(wrapper.getBatch().getName()).to.equal(batchName);
    expect(wrapper.getBatch().getId()).to.equal(batchId);
  });

  it('renders the correct sizeMode', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      browser: {width: 320, height: 480},
      appName,
    });

    const resourceUrls = wrapper.goodResourceUrls;
    const cdt = loadJsonFixture('test.cdt.json');
    checkWindow({
      resourceUrls,
      cdt,
      tag: 'good1',
      sizeMode: 'some size mode',
      url: `${baseUrl}/test.html`,
    });
    expect((await close())[0].map(r => r.getAsExpected())).to.eql([true]);
  });

  it('runs matchWindow in the correct order', async () => {
    const wrapper1 = new FakeEyesWrapper({goodFilename: 'test.cdt.json', goodResourceUrls: []});
    const wrapper2 = new FakeEyesWrapper({goodFilename: 'test.cdt.json', goodResourceUrls: []});

    wrapper1.checkWindow = async function({tag}) {
      if (tag === 'one') {
        await psetTimeout(200);
      } else if (tag === 'two') {
        await psetTimeout(50);
      }
      this.results.push(`${tag}1`);
    };

    wrapper2.checkWindow = async function({tag}) {
      if (tag === 'one') {
        await psetTimeout(150);
      } else if (tag === 'two') {
        await psetTimeout(150);
      }
      this.results.push(`${tag}2`);
    };

    wrapper1.close = wrapper2.close = async function() {
      return this.results;
    };

    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper1, wrapper2],
      browser: [{width: 320, height: 480}, {width: 640, height: 768}],
      appName,
    });

    const resourceUrls = wrapper.goodResourceUrls;
    const cdt = loadJsonFixture('test.cdt.json');
    checkWindow({resourceUrls, cdt, tag: 'one', url: `${baseUrl}/test.html`});
    checkWindow({resourceUrls, cdt, tag: 'two', url: `${baseUrl}/test.html`});
    checkWindow({resourceUrls, cdt, tag: 'three', url: `${baseUrl}/test.html`});
    expect(await close()).to.eql([['one1', 'two1', 'three1'], ['one2', 'two2', 'three2']]);
  });

  it('handles resourceContents in checkWindow', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    const blobUrl = `blob.css`;
    const resourceContents = {
      [blobUrl]: {
        url: blobUrl,
        type: 'text/css',
        value: loadFixtureBuffer('blob.css'),
      },
    };

    wrapper.goodResourceUrls = [`${baseUrl}/blob.css`, `${baseUrl}/smurfs4.jpg`];

    checkWindow({cdt: [], resourceContents, tag: 'good1', url: `${baseUrl}/test.html`});
    expect((await close())[0].map(r => r.getAsExpected())).to.eql([true]);
  });

  it('handles "selector" sizeMode', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    checkWindow({cdt: [], url: 'some url', selector: 'some selector'});
    expect((await close())[0].map(r => r.getAsExpected())).to.eql([true]);
  });

  it('handles "region" sizeMode', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    checkWindow({cdt: [], url: 'some url', region: {width: 1, height: 2, left: 3, top: 4}});
    expect((await close())[0].map(r => r.getAsExpected())).to.eql([true]);
  });

  it('renders the correct browser', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      browser: {width: 320, height: 480, name: 'ucbrowser'},
      url: `${baseUrl}/test.html`,
      appName,
    });

    const resourceUrls = wrapper.goodResourceUrls;
    const cdt = loadJsonFixture('test.cdt.json');
    checkWindow({
      resourceUrls,
      cdt,
      tag: 'good1',
      sizeMode: 'some size mode',
      url: `${baseUrl}/test.html`,
    });
    await close();
    expect(await wrapper.getInferredEnvironment()).to.equal('useragent:ucbrowser');
  });

  it('openEyes handles error during getRenderInfo', async () => {
    wrapper.getRenderInfo = async () => {
      await psetTimeout(0);
      throw new Error('getRenderInfo');
    };

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
    }).openEyes;

    await psetTimeout(50);

    const [error] = await presult(
      openEyes({
        wrappers: [wrapper],
        appName,
      }),
    );
    expect(error.message).to.equal('getRenderInfo');
  });

  it('openEyes handles authorization error during getRenderInfo', async () => {
    wrapper.getRenderInfo = async () => {
      await psetTimeout(0);
      const err = new Error('');
      err.response = {status: 401};
      throw err;
    };

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
    }).openEyes;

    await psetTimeout(50);

    const [error] = await presult(
      openEyes({
        wrappers: [wrapper],
        appName,
      }),
    );
    expect(error.message).to.equal(authorizationErrMsg);
  });

  it('openEyes handles blocked account error during getRenderInfo', async () => {
    wrapper.getRenderInfo = async () => {
      await psetTimeout(0);
      const err = new Error('');
      err.response = {status: 403};
      throw err;
    };

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
    }).openEyes;

    await psetTimeout(50);

    const [error] = await presult(
      openEyes({
        wrappers: [wrapper],
        appName,
      }),
    );
    expect(error.message).to.equal(blockedAccountErrMsg);
  });

  it('openEyes handles blocked account error during getRenderInfo', async () => {
    wrapper.getRenderInfo = async () => {
      await psetTimeout(0);
      const err = new Error('');
      err.response = {status: 400};
      throw err;
    };

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
    }).openEyes;

    await psetTimeout(50);

    const [error] = await presult(
      openEyes({
        wrappers: [wrapper],
        appName,
      }),
    );
    expect(error.message).to.equal(badRequestErrMsg);
  });

  it('openEyes handles missing appName', async () => {
    const [error] = await presult(openEyes({wrappers: [wrapper], apiKey}));
    expect(error.message).to.equal(appNameFailMsg);
  });

  it('handles error during rendering', async () => {
    let error;
    wrapper.renderBatch = async () => {
      throw new Error('renderBatch');
    };
    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
    }).openEyes;
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      url: `bla`,
      appName,
    });

    checkWindow({resourceUrls: [], cdt: [], url: `bla`});
    await psetTimeout(0);
    checkWindow({resourceUrls: [], cdt: [], url: `bla`});
    error = await close().then(x => x, err => err);
    expect(error.message).to.equal('renderBatch');
  });

  it('handles error during checkWindow', async () => {
    let error;
    wrapper.checkWindow = async () => {
      throw new Error('checkWindow');
    };
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    checkWindow({resourceUrls: [], cdt: [], url: `bla`});
    await psetTimeout(0);
    checkWindow({resourceUrls: [], cdt: [], url: `bla`});
    error = await close().then(x => x, err => err);
    expect(error.message).to.equal('checkWindow');
  });

  it('throws error during close', async () => {
    let error;
    wrapper.close = async () => {
      await psetTimeout(0);
      throw new Error('close');
    };
    const {close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    error = await close().then(x => x, err => err);
    expect(error.message).to.equal('close');
  });

  describe('concurrency', () => {
    it('runs open/close with max concurrency', async () => {
      const wrapper1 = createFakeWrapper(baseUrl);
      const wrapper2 = createFakeWrapper(baseUrl);
      const wrapper3 = createFakeWrapper(baseUrl);

      let flag;
      wrapper3.open = async () => {
        flag = true;
      };

      openEyes = makeRenderingGridClient({
        concurrency: 2,
        apiKey,
        showLogs: APPLITOOLS_SHOW_LOGS,
        renderWrapper: wrapper,
      }).openEyes;

      const {close} = await openEyes({
        wrappers: [wrapper1],
        appName,
      });
      await openEyes({
        wrappers: [wrapper2],
        appName,
      });
      openEyes({
        wrappers: [wrapper3],
        appName,
      });
      expect(flag).to.equal(undefined);
      await close();
      expect(flag).to.equal(true);
    });

    it('ends throat job when close throws', async () => {
      wrapper.close = async () => {
        await psetTimeout(0);
        throw new Error('close');
      };

      openEyes = makeRenderingGridClient({
        concurrency: 1,
        apiKey,
        showLogs: APPLITOOLS_SHOW_LOGS,
        renderWrapper: wrapper,
      }).openEyes;

      const {close} = await openEyes({
        wrappers: [wrapper],
        appName,
      });
      const err1 = await close().then(x => x, err => err);
      expect(err1.message).to.equal('close');
      const {close: close2} = await Promise.race([
        openEyes({
          wrappers: [wrapper],
          appName,
        }),
        psetTimeout(100).then(() => ({close: 'not resolved'})),
      ]);
      expect(close2).not.to.equal('not resolved');
      const err2 = await close2().then(x => x, err => err);
      expect(err2.message).to.equal('close');
    });

    it('ends throat job when render throws', async () => {
      let count = 0;
      const renderBatch = wrapper.renderBatch;
      wrapper.renderBatch = async function() {
        await psetTimeout(0);
        if (count++) {
          return renderBatch.apply(this, arguments);
        } else {
          throw new Error('renderBatch');
        }
      };

      openEyes = makeRenderingGridClient({
        concurrency: 1,
        apiKey,
        showLogs: APPLITOOLS_SHOW_LOGS,
        renderWrapper: wrapper,
      }).openEyes;

      const {checkWindow, close} = await openEyes({
        wrappers: [wrapper],
        appName,
      });
      checkWindow({cdt: [], url: 'url'});
      const err1 = await close().then(x => x, err => err);
      expect(err1.message).to.equal('renderBatch');
      const {checkWindow: checkWindow2, close: close2} = await Promise.race([
        openEyes({
          wrappers: [wrapper],
          appName,
        }),
        psetTimeout(100).then(() => ({close: 'not resolved'})),
      ]);
      expect(close2).not.to.equal('not resolved');
      checkWindow2({cdt: [], url: 'url'});
      const result2 = await close2().then(x => x, err => err);
      expect(result2).not.to.be.an.instanceOf(Error);
    });

    // TODO statuser makes this test impossible to fix. need to check concurrency
    it.skip("doesn't wait for eyes test to open in order to perform renderings", async () => {
      openEyes = makeRenderingGridClient({
        concurrency: 1,
        apiKey,
        showLogs: APPLITOOLS_SHOW_LOGS,
        renderWrapper: wrapper,
      }).openEyes;

      const wrapper1Counters = {
        open: 0,
        checkWindow: 0,
        render: 0,
        renderStatus: 0,
        close: 0,
      };
      const wrapper2Counters = {
        open: 0,
        checkWindow: 0,
        render: 0,
        renderStatus: 0,
        close: 0,
      };

      const wrapper1 = createFakeWrapper(baseUrl);
      const wrapper2 = createFakeWrapper(baseUrl);

      wrapper1.open = async () => {
        await psetTimeout(50);
        wrapper1Counters.open++;
      };

      wrapper2.open = async () => {
        await psetTimeout(50);
        wrapper2Counters.open++;
      };

      wrapper1.checkWindow = async () => {
        await psetTimeout(100);
        wrapper1Counters.checkWindow++;
      };

      wrapper2.checkWindow = async () => {
        await psetTimeout(100);
        wrapper2Counters.checkWindow++;
      };

      wrapper1.renderBatch = async () => {
        await psetTimeout(wrapper1Counters.render === 0 ? 150 : 50);
        wrapper1Counters.render++;
        return [new FakeRunningRender(`renderId${wrapper1Counters.render}`, RenderStatus.RENDERED)];
      };

      wrapper2.renderBatch = async () => {
        await psetTimeout(50);
        wrapper2Counters.render++;
        return [new FakeRunningRender(`renderId${wrapper2Counters.render}`, RenderStatus.RENDERED)];
      };

      wrapper1.getRenderStatus = async () => {
        await psetTimeout(wrapper1Counters.renderStatus === 0 ? 50 : 0);
        wrapper1Counters.renderStatus++;
        return [
          new RenderStatusResults({
            status: RenderStatus.RENDERED,
          }),
        ];
      };

      wrapper2.getRenderStatus = async () => {
        await psetTimeout(wrapper1Counters.renderStatus === 0 ? 0 : 50);
        wrapper2Counters.renderStatus++;
        return [
          new RenderStatusResults({
            status: RenderStatus.RENDERED,
          }),
        ];
      };

      wrapper1.close = async () => {
        await psetTimeout(50);
        wrapper1Counters.close++;
        return 'close1';
      };

      wrapper2.close = async () => {
        await psetTimeout(50);
        wrapper2Counters.close++;
        return 'close2';
      };

      const {checkWindow: checkWindow1, close: close1} = await openEyes({
        wrappers: [wrapper1],
        appName,
      });

      await psetTimeout(0);

      // t0
      expect(wrapper1Counters.open).to.equal(0);
      await psetTimeout(50);

      // t1
      expect(wrapper1Counters.open).to.equal(1);
      checkWindow1({cdt: [], url: 'url'});
      await psetTimeout(0);
      expect(wrapper1Counters.render).to.equal(0);
      await psetTimeout(50);

      // t2
      expect(wrapper1Counters.render).to.equal(0);
      checkWindow1({cdt: [], url: 'url'});
      await psetTimeout(0);
      expect(wrapper1Counters.render).to.equal(0);
      expect(wrapper1Counters.renderStatus).to.equal(0);
      await psetTimeout(50);

      // t3
      expect(wrapper1Counters.render).to.equal(0);
      expect(wrapper1Counters.renderStatus).to.equal(0);
      await psetTimeout(0);
      expect(wrapper1Counters.render).to.equal(0);
      expect(wrapper1Counters.renderStatus).to.equal(0);
      close1();
      await psetTimeout(50);

      // t4
      const {checkWindow: checkWindow2, close: close2} = await openEyes({
        wrappers: [wrapper2],
        appName,
      });
      expect(wrapper1Counters.render).to.equal(1);
      expect(wrapper1Counters.renderStatus).to.equal(0);
      await psetTimeout(50);

      // t5
      expect(wrapper1Counters.render).to.equal(2);
      checkWindow2({cdt: [], url: 'url'});
      await psetTimeout(50);

      // t6
      expect(wrapper1Counters.render).to.equal(2);
      expect(wrapper1Counters.renderStatus).to.equal(2);
      expect(wrapper2Counters.open).to.equal(0);
      checkWindow2({cdt: [], url: 'url'});
      await psetTimeout(50);

      // t7
      close2();
      expect(wrapper1Counters.checkWindow).to.equal(1);
      expect(wrapper2Counters.open).to.equal(0);
      await psetTimeout(50);

      // t8
      expect(wrapper1Counters.checkWindow).to.equal(1);
      expect(wrapper2Counters.open).to.equal(0);
      await psetTimeout(50);

      // t9
      expect(wrapper1Counters.checkWindow).to.equal(2);
      expect(wrapper2Counters.render).to.equal(2);
      expect(wrapper2Counters.renderStatus).to.equal(2);
      expect(wrapper2Counters.open).to.equal(0);
      await psetTimeout(50);

      // t10
      expect(wrapper1Counters.close).to.equal(1);
      expect(wrapper2Counters.open).to.equal(0);
      expect(wrapper2Counters.checkWindow).to.equal(0);
      await psetTimeout(50);

      // t11
      await psetTimeout(50);

      // t12
      expect(wrapper2Counters.open).to.equal(1);
      await psetTimeout(50);

      // t13
      await psetTimeout(50);

      // t14
      await psetTimeout(50);

      // t15
      await psetTimeout(50);

      // t16
      expect(wrapper2Counters.checkWindow).to.equal(2);
      expect(wrapper2Counters.close).to.equal(1);
    });
  });

  describe('max concurrency for render', () => {
    let renderCount;
    let renderStatusCount;
    let runningStatuses;
    beforeEach(() => {
      renderCount = 0;
      renderStatusCount = 0;
      runningStatuses = [];
      const renderBatch = wrapper.renderBatch;
      wrapper.renderBatch = function(renderRequests) {
        renderCount += renderRequests.length;
        runningStatuses = runningStatuses.concat(renderRequests.map(() => RenderStatus.RENDERING));
        return renderBatch.apply(this, arguments);
      };
      wrapper.getRenderStatus = async renderIds => {
        // console.log('runningStatuses', runningStatuses, 'renderIds', renderIds);
        renderStatusCount++;
        const statuses = runningStatuses
          .filter(x => !!x)
          .map(
            status =>
              new RenderStatusResults({
                status: status,
                imageLocation: JSON.stringify({isGood: true}),
              }),
          );
        runningStatuses = runningStatuses.map(status =>
          status === RenderStatus.RENDERED ? false : status,
        );

        expect(renderIds.length).to.equal(statuses.length);

        return statuses;
      };
    });

    beforeEach(() => {
      openEyes = makeRenderingGridClient({
        concurrency: 2,
        renderConcurrencyFactor: 1,
        apiKey,
        showLogs: APPLITOOLS_SHOW_LOGS,
        renderWrapper: wrapper,
      }).openEyes;
    });

    it('runs renders with max concurrency', async () => {
      const {checkWindow, close} = await openEyes({
        wrappers: [wrapper],
        appName,
      });
      checkWindow({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);
      expect(renderCount).to.equal(1);
      expect(renderStatusCount).to.equal(0); // still batching initial renderIds for /render-status request

      checkWindow({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);
      expect(renderCount).to.equal(2);
      expect(renderStatusCount).to.equal(0); // still batching initial renderIds for /render-status request

      checkWindow({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);
      expect(renderCount).to.equal(2); // concurrency is blocking this render
      expect(renderStatusCount).to.equal(0); // still batching initial renderIds for /render-status request

      await psetTimeout(150);

      expect(renderCount).to.equal(2);
      expect(renderStatusCount).to.equal(1);

      runningStatuses[0] = RenderStatus.RENDERED;

      await psetTimeout(600);
      expect(renderStatusCount).to.equal(2);

      await psetTimeout(500);
      expect(renderCount).to.equal(3);
      expect(renderStatusCount).to.equal(3);

      runningStatuses[1] = RenderStatus.RENDERED;
      runningStatuses[2] = RenderStatus.RENDERED;
      await close();
    });

    it('runs renders with max concurrency for multiple browsers', async () => {
      const {checkWindow, close} = await openEyes({
        wrappers: [wrapper, wrapper],
        browser: [{width: 1, height: 1}, {width: 2, height: 2}],
        appName,
      });

      checkWindow({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);
      checkWindow({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);
      const expected1 = renderCount;
      runningStatuses[0] = RenderStatus.RENDERED;
      await psetTimeout(600);
      const expected2 = renderCount;

      runningStatuses[1] = RenderStatus.RENDERED;
      runningStatuses[2] = RenderStatus.RENDERED;
      runningStatuses[3] = RenderStatus.RENDERED;

      await close();
      expect(expected1).to.equal(2);
      expect(expected2).to.equal(4);
      expect(renderCount).to.equal(4);
    });

    it('runs renders with max concurrency between open/close', async () => {
      const {checkWindow, close} = await openEyes({
        wrappers: [wrapper],
        appName,
      });

      const {checkWindow: checkWindow2, close: close2} = await openEyes({
        wrappers: [wrapper],
        appName,
      });

      checkWindow({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);

      checkWindow2({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);

      checkWindow({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);

      checkWindow2({url: '', cdt: [], sizeMode: null});
      await psetTimeout(0);

      const expected1 = renderCount;
      runningStatuses[0] = RenderStatus.RENDERED;
      await psetTimeout(600);

      const expected2 = renderCount;
      runningStatuses[1] = RenderStatus.RENDERED;
      runningStatuses[2] = RenderStatus.RENDERED;
      runningStatuses[3] = RenderStatus.RENDERED;

      await close();
      await close2();
      expect(expected1).to.equal(2);
      expect(expected2).to.equal(4);
      expect(renderCount).to.equal(4);
    });

    it('resolves render job when error in getRenderStatus happens', async () => {
      openEyes = makeRenderingGridClient({
        concurrency: 1,
        renderConcurrencyFactor: 1,
        apiKey,
        showLogs: APPLITOOLS_SHOW_LOGS,
        renderWrapper: wrapper,
      }).openEyes;

      const {checkWindow, close} = await openEyes({
        wrappers: [wrapper],
        appName,
      });

      checkWindow({url: '', cdt: [], selector: '111'});
      await psetTimeout(0);
      expect(renderCount).to.equal(1);
      expect(renderStatusCount).to.equal(0);

      await psetTimeout(150);
      expect(renderStatusCount).to.equal(1);

      checkWindow({url: '', cdt: [], selector: '222'});
      await psetTimeout(0);
      expect(renderCount).to.equal(1);
      expect(renderStatusCount).to.equal(1);

      runningStatuses[0] = RenderStatus.ERROR;
      await psetTimeout(600);
      expect(renderCount).to.equal(2);
      expect(renderStatusCount).to.equal(2);

      const [err] = await presult(close());
      expect(err).to.be.an.instanceOf(Error);
      expect(err.message).to.equal('failed to render screenshot');
    });

    it.skip('resolves render job when error in happens while in getRenderStatus (but not because of that specific render)', async () => {
      // TODO
    });
  });

  it('handles render status timeout when second checkWindow starts AFTER timeout of previous checkWindow', async () => {
    wrapper.getRenderStatus = async renderIds => {
      await psetTimeout(0);
      return renderIds.map(_renderId => new RenderStatusResults({status: RenderStatus.RENDERING}));
    };

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderStatusTimeout: 50,
      renderStatusInterval: 50,
      renderWrapper: wrapper,
    }).openEyes;

    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    checkWindow({resourceUrls: [], cdt: [], url: 'bla', tag: 'good1'});
    await psetTimeout(150);
    checkWindow({resourceUrls: [], cdt: [], url: 'bla', tag: 'good1'});

    const [err3] = await presult(close());
    expect(err3.message).to.equal('failed to render screenshot');
  });

  it('handles render status timeout when second checkWindow starts BEFORE timeout of previous checkWindow', async () => {
    wrapper.getRenderStatus = async renderIds => {
      await psetTimeout(0);
      return renderIds.map(_renderId => new RenderStatusResults({status: RenderStatus.RENDERING}));
    };

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderStatusTimeout: 150,
      renderStatusInterval: 50,
      renderWrapper: wrapper,
    }).openEyes;

    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    checkWindow({resourceUrls: [], cdt: [], url: 'bla', tag: 'good1'});
    await psetTimeout(0);
    checkWindow({resourceUrls: [], cdt: [], url: 'bla', tag: 'good1'});
    await psetTimeout(200);
    const [err3] = await presult(close());
    expect(err3.message).to.equal('failed to render screenshot');
  });

  it('sets configuration on wrappers', () => {
    const wrappers = [
      createFakeWrapper(baseUrl),
      createFakeWrapper(baseUrl),
      createFakeWrapper(baseUrl),
    ];

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
      serverUrl: 'serverUrl',
      proxy: 'proxy',
      agentId: 'agentId',
    }).openEyes;

    openEyes({
      wrappers,
      url: 'bla',
      appName,
      baselineBranchName: 'baselineBranchName',
      baselineEnvName: 'baselineEnvName',
      baselineName: 'baselineName',
      envName: 'envName',
      ignoreCaret: 'ignoreCaret',
      isDisabled: false,
      matchLevel: 'matchLevel',
      matchTimeout: 'matchTimeout',
      parentBranchName: 'parentBranchName',
      branchName: 'branchName',
      saveFailedTests: 'saveFailedTests',
      saveNewTests: 'saveNewTests',
      compareWithParentBranch: 'compareWithParentBranch',
      ignoreBaseline: 'ignoreBaseline',
      browser: [{deviceName: 'device1'}, {deviceName: 'device2'}, {}],
      agentId: 'agentId',
    });

    for (const wrapper of wrappers) {
      expect(wrapper.baselineBranchName).to.equal('baselineBranchName');
      expect(wrapper.baselineEnvName).to.equal('baselineEnvName');
      expect(wrapper.baselineName).to.equal('baselineName');
      expect(wrapper.envName).to.equal('envName');
      expect(wrapper.ignoreCaret).to.equal('ignoreCaret');
      expect(wrapper.isDisabled).to.equal(false);
      expect(wrapper.matchLevel).to.equal('matchLevel');
      expect(wrapper.matchTimeout).to.equal('matchTimeout');
      expect(wrapper.parentBranchName).to.equal('parentBranchName');
      expect(wrapper.branchName).to.equal('branchName');
      expect(wrapper.proxy).to.equal('proxy');
      expect(wrapper.saveFailedTests).to.equal('saveFailedTests');
      expect(wrapper.saveNewTests).to.equal('saveNewTests');
      expect(wrapper.compareWithParentBranch).to.equal('compareWithParentBranch');
      expect(wrapper.ignoreBaseline).to.equal('ignoreBaseline');
      expect(wrapper.serverUrl).to.equal('serverUrl');
      expect(wrapper.agentId).to.equal('agentId');
    }

    expect(wrappers[0].deviceInfo).to.equal('device1 (Chrome emulation)');
    expect(wrappers[1].deviceInfo).to.equal('device2 (Chrome emulation)');
    expect(wrappers[2].deviceInfo).to.equal('Desktop');
  });

  it('sets configuration on wrappers in makeRenderingGridClient', () => {
    const wrappers = [
      createFakeWrapper(baseUrl),
      createFakeWrapper(baseUrl),
      createFakeWrapper(baseUrl),
    ];

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
      serverUrl: 'serverUrl',
      proxy: 'proxy',
      appName,
      baselineBranchName: 'baselineBranchName',
      baselineEnvName: 'baselineEnvName',
      baselineName: 'baselineName',
      envName: 'envName',
      ignoreCaret: 'ignoreCaret',
      isDisabled: false,
      matchLevel: 'matchLevel',
      matchTimeout: 'matchTimeout',
      parentBranchName: 'parentBranchName',
      branchName: 'branchName',
      saveFailedTests: 'saveFailedTests',
      saveNewTests: 'saveNewTests',
      compareWithParentBranch: 'compareWithParentBranch',
      ignoreBaseline: 'ignoreBaseline',
      browser: [{deviceName: 'device1'}, {deviceName: 'device2'}, {}],
      agentId: 'agentId',
    }).openEyes;

    openEyes({
      wrappers,
      url: 'bla',
    });

    for (const wrapper of wrappers) {
      expect(wrapper.baselineBranchName).to.equal('baselineBranchName');
      expect(wrapper.baselineEnvName).to.equal('baselineEnvName');
      expect(wrapper.baselineName).to.equal('baselineName');
      expect(wrapper.envName).to.equal('envName');
      expect(wrapper.ignoreCaret).to.equal('ignoreCaret');
      expect(wrapper.isDisabled).to.equal(false);
      expect(wrapper.matchLevel).to.equal('matchLevel');
      expect(wrapper.matchTimeout).to.equal('matchTimeout');
      expect(wrapper.parentBranchName).to.equal('parentBranchName');
      expect(wrapper.branchName).to.equal('branchName');
      expect(wrapper.proxy).to.equal('proxy');
      expect(wrapper.saveFailedTests).to.equal('saveFailedTests');
      expect(wrapper.saveNewTests).to.equal('saveNewTests');
      expect(wrapper.compareWithParentBranch).to.equal('compareWithParentBranch');
      expect(wrapper.ignoreBaseline).to.equal('ignoreBaseline');
      expect(wrapper.serverUrl).to.equal('serverUrl');
      expect(wrapper.agentId).to.equal('agentId');
    }

    expect(wrappers[0].deviceInfo).to.equal('device1 (Chrome emulation)');
    expect(wrappers[1].deviceInfo).to.equal('device2 (Chrome emulation)');
    expect(wrappers[2].deviceInfo).to.equal('Desktop');
  });

  it('sets proxy with username/password wrappers', () => {
    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
      proxy: {uri: 'uri', username: 'user', password: 'pass'},
    }).openEyes;

    openEyes({
      wrappers: [wrapper],
      appName,
    });

    expect(wrapper.proxy).to.eql(new ProxySettings('uri', 'user', 'pass'));

    openEyes = makeRenderingGridClient({
      showLogs: APPLITOOLS_SHOW_LOGS,
      apiKey,
      renderWrapper: wrapper,
      proxy: null,
    }).openEyes;

    openEyes({
      wrappers: [wrapper],
      appName,
    });

    expect(wrapper.proxy).to.be.null;
  });

  it("doesn't do anything when isDisabled", async () => {
    const {checkWindow, close, abort} = await openEyes({
      isDisabled: true,
      wrappers: [{_logger: console}],
    });

    checkWindow({});
    expect(await close()).to.equal(undefined);
    expect(await abort()).to.equal(undefined);
  });

  it('throws missing apiKey msg', async () => {
    try {
      makeRenderingGridClient({}).openEyes;
    } catch (err) {
      expect(err.message).to.equal(apiKeyFailMsg);
    }
  });

  it("doesn't init wrapper when isDisabled", async () => {
    const result = await openEyes({isDisabled: true}).then(x => x, err => err);
    expect(result).not.to.be.instanceof(Error);
  });

  it('handles ignore regions', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });
    const region = {left: 1, top: 2, width: 3, height: 4};
    checkWindow({
      url: '',
      // resourceUrls: [],
      cdt: [],
      ignore: [region],
    });
    const [results] = await close();
    expect(results[0].getAsExpected()).to.equal(true);
    expect(results[0].__checkSettings.getIgnoreRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(region)),
    ]);
  });

  it('handles layout and strict regions', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    const regionLayout = {left: 1, top: 2, width: 3, height: 4};
    const regionStrict = {left: 10, top: 20, width: 30, height: 40};
    checkWindow({
      url: '',
      // resourceUrls: [],
      cdt: [],
      layout: [regionLayout],
      strict: [regionStrict],
    });
    const [results] = await close();
    expect(results[0].getAsExpected()).to.equal(true);
    expect(results[0].__checkSettings.getLayoutRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(regionLayout)),
    ]);
    expect(results[0].__checkSettings.getStrictRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(regionStrict)),
    ]);
  });

  it('handles ignore, layout and strict regions with selector', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    const ignoreSelector1 = {selector: 'sel1'};
    const region1FromStatusResults = FakeEyesWrapper.selectorsToLocations['sel1'];
    const region1 = new Region({
      left: region1FromStatusResults.x,
      top: region1FromStatusResults.y,
      width: region1FromStatusResults.width,
      height: region1FromStatusResults.height,
    });

    const layoutSelector1 = {selector: 'sel2'};
    const regionLayout1FromStatusResults = FakeEyesWrapper.selectorsToLocations['sel2'];
    const regionLayout1 = new Region({
      left: regionLayout1FromStatusResults.x,
      top: regionLayout1FromStatusResults.y,
      width: regionLayout1FromStatusResults.width,
      height: regionLayout1FromStatusResults.height,
    });

    const strictSelector1 = {selector: 'sel3'};
    const regionStrict1FromStatusResults = FakeEyesWrapper.selectorsToLocations['sel3'];
    const regionStrict1 = new Region({
      left: regionStrict1FromStatusResults.x,
      top: regionStrict1FromStatusResults.y,
      width: regionStrict1FromStatusResults.width,
      height: regionStrict1FromStatusResults.height,
    });

    const ignoreSelector2 = {selector: 'sel4'};
    const region2FromStatusResults = FakeEyesWrapper.selectorsToLocations['sel4'];
    const region2 = new Region({
      left: region2FromStatusResults.x,
      top: region2FromStatusResults.y,
      width: region2FromStatusResults.width,
      height: region2FromStatusResults.height,
    });

    const layoutSelector2 = {selector: 'sel5'};
    const regionLayout2FromStatusResults = FakeEyesWrapper.selectorsToLocations['sel5'];
    const regionLayout2 = new Region({
      left: regionLayout2FromStatusResults.x,
      top: regionLayout2FromStatusResults.y,
      width: regionLayout2FromStatusResults.width,
      height: regionLayout2FromStatusResults.height,
    });

    const strictSelector2 = {selector: 'sel6'};
    const regionStrict2FromStatusResults = FakeEyesWrapper.selectorsToLocations['sel6'];
    const regionStrict2 = new Region({
      left: regionStrict2FromStatusResults.x,
      top: regionStrict2FromStatusResults.y,
      width: regionStrict2FromStatusResults.width,
      height: regionStrict2FromStatusResults.height,
    });

    checkWindow({
      url: '',
      // resourceUrls: [],
      cdt: [],
      ignore: [ignoreSelector1, ignoreSelector2],
      layout: [layoutSelector1, layoutSelector2],
      strict: [strictSelector1, strictSelector2],
    });
    const [results] = await close();
    expect(results[0].getAsExpected()).to.equal(true);
    expect(results[0].__checkSettings.getIgnoreRegions()).to.eql([
      new IgnoreRegionByRectangle(region1),
      new IgnoreRegionByRectangle(region2),
    ]);
    expect(results[0].__checkSettings.getLayoutRegions()).to.eql([
      new IgnoreRegionByRectangle(regionLayout1),
      new IgnoreRegionByRectangle(regionLayout2),
    ]);
    expect(results[0].__checkSettings.getStrictRegions()).to.eql([
      new IgnoreRegionByRectangle(regionStrict1),
      new IgnoreRegionByRectangle(regionStrict2),
    ]);
  });

  it('handles ignore, layout and strict regions with selector, when sizeMode===selector', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });
    const selector = 'sel1';
    const ignoreRegion = {left: 1, top: 2, width: 3, height: 4};
    const layoutRegion = {left: 10, top: 20, width: 30, height: 40};
    const strictRegion = {left: 100, top: 200, width: 300, height: 400};
    const ignoreSelector = {selector: 'sel2'};
    const layoutSelector = {selector: 'sel1'};
    const strictSelector = {selector: 'sel3'};
    const imageOffset = FakeEyesWrapper.selectorsToLocations[selector];
    const expectedIgnoreSelectorRegion = FakeEyesWrapper.selectorsToLocations['sel2'];
    const expectedLayoutSelectorRegion = FakeEyesWrapper.selectorsToLocations['sel1'];
    const expectedStrictSelectorRegion = FakeEyesWrapper.selectorsToLocations['sel3'];
    checkWindow({
      url: '',
      // resourceUrls: [],
      cdt: [],
      sizeMode: 'selector',
      selector,
      ignore: [ignoreRegion, ignoreSelector],
      layout: [layoutRegion, layoutSelector],
      strict: [strictRegion, strictSelector],
    });

    const [results] = await close();
    expect(results[0].getAsExpected()).to.equal(true);
    expect(results[0].__checkSettings.getIgnoreRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(ignoreRegion)),
      new IgnoreRegionByRectangle(
        new Region({
          left: expectedIgnoreSelectorRegion.x - imageOffset.x,
          top: expectedIgnoreSelectorRegion.y - imageOffset.y,
          width: expectedIgnoreSelectorRegion.width,
          height: expectedIgnoreSelectorRegion.height,
        }),
      ),
    ]);
    expect(results[0].__checkSettings.getLayoutRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(layoutRegion)),
      new IgnoreRegionByRectangle(
        new Region({
          left: expectedLayoutSelectorRegion.x - imageOffset.x,
          top: expectedLayoutSelectorRegion.y - imageOffset.y,
          width: expectedLayoutSelectorRegion.width,
          height: expectedLayoutSelectorRegion.height,
        }),
      ),
    ]);
    expect(results[0].__checkSettings.getStrictRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(strictRegion)),
      new IgnoreRegionByRectangle(
        new Region({
          left: expectedStrictSelectorRegion.x - imageOffset.x,
          top: expectedStrictSelectorRegion.y - imageOffset.y,
          width: expectedStrictSelectorRegion.width,
          height: expectedStrictSelectorRegion.height,
        }),
      ),
    ]);
  });

  it('handles ignore, layout and strict regions with selector and floating regions with selector, when sizeMode===selector', async () => {
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });
    const selector = 'sel1';
    const ignoreRegion = {left: 1, top: 2, width: 3, height: 4};
    const layoutRegion = {left: 10, top: 20, width: 30, height: 40};
    const strictRegion = {left: 100, top: 200, width: 300, height: 400};
    const ignoreSelector = {selector: 'sel2'};
    const layoutSelector = {selector: 'sel1'};
    const strictSelector = {selector: 'sel3'};
    const imageOffset = FakeEyesWrapper.selectorsToLocations[selector];
    const expectedIgnoreSelectorRegion = FakeEyesWrapper.selectorsToLocations['sel2'];
    const expectedLayoutSelectorRegion = FakeEyesWrapper.selectorsToLocations['sel1'];
    const expectedStrictSelectorRegion = FakeEyesWrapper.selectorsToLocations['sel3'];

    const floatingRegion = {
      left: 10,
      top: 11,
      width: 12,
      height: 13,
      maxUpOffset: 14,
      maxDownOffset: 15,
      maxLeftOffset: 16,
      maxRightOffset: 17,
    };

    const expectedFloatingRegion = FakeEyesWrapper.selectorsToLocations['sel3'];
    const floatingSelector = {
      selector: 'sel3',
      maxUpOffset: 18,
      maxDownOffset: 19,
      maxLeftOffset: 20,
      maxRightOffset: 21,
    };

    checkWindow({
      url: '',
      // resourceUrls: [],
      cdt: [],
      sizeMode: 'selector',
      selector,
      ignore: [ignoreRegion, ignoreSelector],
      layout: [layoutRegion, layoutSelector],
      strict: [strictRegion, strictSelector],
      floating: [floatingRegion, floatingSelector],
    });

    const [results] = await close();

    expect(results[0].getAsExpected()).to.equal(true);
    expect(results[0].__checkSettings.getIgnoreRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(ignoreRegion)),
      new IgnoreRegionByRectangle(
        new Region({
          left: expectedIgnoreSelectorRegion.x - imageOffset.x,
          top: expectedIgnoreSelectorRegion.y - imageOffset.y,
          width: expectedIgnoreSelectorRegion.width,
          height: expectedIgnoreSelectorRegion.height,
        }),
      ),
    ]);
    expect(results[0].__checkSettings.getLayoutRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(layoutRegion)),
      new IgnoreRegionByRectangle(
        new Region({
          left: expectedLayoutSelectorRegion.x - imageOffset.x,
          top: expectedLayoutSelectorRegion.y - imageOffset.y,
          width: expectedLayoutSelectorRegion.width,
          height: expectedLayoutSelectorRegion.height,
        }),
      ),
    ]);
    expect(results[0].__checkSettings.getStrictRegions()).to.eql([
      new IgnoreRegionByRectangle(new Region(strictRegion)),
      new IgnoreRegionByRectangle(
        new Region({
          left: expectedStrictSelectorRegion.x - imageOffset.x,
          top: expectedStrictSelectorRegion.y - imageOffset.y,
          width: expectedStrictSelectorRegion.width,
          height: expectedStrictSelectorRegion.height,
        }),
      ),
    ]);

    expect(results[0].__checkSettings.getFloatingRegions()).to.eql([
      new FloatingRegionByRectangle(
        new Region(floatingRegion),
        floatingRegion.maxUpOffset,
        floatingRegion.maxDownOffset,
        floatingRegion.maxLeftOffset,
        floatingRegion.maxRightOffset,
      ),
      new FloatingRegionByRectangle(
        new Region({
          left: expectedFloatingRegion.x - imageOffset.x,
          top: expectedFloatingRegion.y - imageOffset.y,
          width: expectedFloatingRegion.width,
          height: expectedFloatingRegion.height,
        }),
        floatingSelector.maxUpOffset,
        floatingSelector.maxDownOffset,
        floatingSelector.maxLeftOffset,
        floatingSelector.maxRightOffset,
      ),
    ]);
  });

  it('handles abort', async () => {
    const wrapper1 = createFakeWrapper(baseUrl);
    const wrapper2 = createFakeWrapper(baseUrl);
    const {abort} = await openEyes({
      wrappers: [wrapper1, wrapper2],
      browser: [{width: 1, height: 2}, {width: 3, height: 4}],
      appName,
    });

    await abort();
    expect(wrapper1.aborted).to.equal(true);
    expect(wrapper2.aborted).to.equal(true);
  });

  it('handles abort by waiting for checkWindow to end', async () => {
    const wrapper1 = createFakeWrapper(baseUrl);
    const {checkWindow, abort} = await openEyes({
      wrappers: [wrapper1],
      browser: [{width: 1, height: 2}],
      appName,
    });

    let done;
    const donePromise = new Promise(res => {
      done = res;
      setTimeout(done, 1000);
    });

    let checkEndedAfterAbort = false;
    wrapper1.on('checkWindowEnd', () => {
      checkEndedAfterAbort = aborted;
      done();
    });
    let aborted = false;
    wrapper1.on('aborted', () => {
      aborted = true;
    });

    await checkWindow({url: '', cdt: []});
    await abort();
    await donePromise;
    expect(checkEndedAfterAbort).to.be.false;
  });

  it('handles abort by waiting for open to end', async () => {
    const wrapper1 = createFakeWrapper(baseUrl);
    wrapper1.checkWindow = () => {
      throw new Error('CHECK_WINDOW NOT WAITING FOR OPEN SINCE THREW ERROR');
    };
    const {checkWindow, abort} = await openEyes({
      wrappers: [wrapper1],
      browser: [{width: 1, height: 2}],
      appName,
    });

    let done;
    const donePromise = new Promise(res => {
      done = res;
      setTimeout(done, 1000);
    });

    let openEndedAfterAbort = false;
    wrapper1.on('openEnd', () => {
      openEndedAfterAbort = aborted;
      done();
    });
    let aborted = false;
    wrapper1.on('aborted', () => {
      aborted = true;
    });

    await checkWindow({url: '', cdt: []});
    await abort();
    await donePromise;
    expect(openEndedAfterAbort).to.be.false;
  });

  it('renders deviceEmulation', async () => {
    const deviceName = 'iPhone 4';
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      browser: {deviceName, screenOrientation: 'bla'},
      appName,
    });

    checkWindow({url: '', cdt: []});
    const [[results]] = await close();
    expect(wrapper.viewportSize.toJSON()).to.eql(FakeEyesWrapper.devices['iPhone 4']);
    expect(wrapper.deviceInfo).to.equal(`${deviceName} (Chrome emulation)`);
    expect(results.getAsExpected()).to.equal(true);
  });

  it("does't call getRenderInfo on wrapper passed to openEyes", async () => {
    let flag = true;
    wrapper.getRenderInfo = async function() {
      await psetTimeout(50);
      flag = false;
      return 'bla';
    };

    const p = openEyes({
      wrappers: [wrapper],
      appName,
    });
    await psetTimeout(0);
    expect(flag).to.equal(true);
    expect(wrapper.renderingInfo).not.to.equal('bla');
    await p;
  });

  it('handles iframes', async () => {
    const frameUrl = `${baseUrl}/test.html`;
    const frames = [
      {
        url: frameUrl,
        cdt: loadJsonFixture('test.cdt.json'),
        resourceUrls: wrapper.goodResourceUrls,
        resourceContents: wrapper.goodResources,
      },
    ];

    const url = `${baseUrl}/inner-frame.html`;

    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });
    checkWindow({cdt: [], frames, url});
    const ttt = await close();
    expect(ttt[0].map(r => r.getAsExpected())).to.eql([true]);
  });

  it('handles empty tests', async () => {
    openEyes = makeRenderingGridClient({
      concurrency: 1,
      apiKey,
      showLogs: APPLITOOLS_SHOW_LOGS,
      renderWrapper: wrapper,
    }).openEyes;

    const {close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    const {close: close2} = await openEyes({
      wrappers: [wrapper],
      appName,
    });

    const promise = presult(close2()).then(([err, result]) => {
      expect(err).to.be.undefined;
      expect(result).not.to.be.an.instanceOf(Error);
    });

    await psetTimeout(50);
    const [err, result] = await presult(close());
    expect(err).to.be.undefined;
    expect(result).not.to.be.an.instanceOf(Error);
    await promise;
  });

  it('sets matchLevel in checkWindow', async () => {
    wrapper.checkWindow = async ({tag}) => {
      await psetTimeout(20);
      expect(wrapper.getMatchLevel()).to.equal(tag === 2 ? 'Layout' : 'Strict');
    };
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
    });
    checkWindow({tag: 1, cdt: [], url: ''});
    await psetTimeout(0);
    checkWindow({matchLevel: 'Layout', tag: 2, cdt: [], url: ''});
    await psetTimeout(0);
    checkWindow({tag: 3, cdt: [], url: ''});
    await close();
  });

  it('sets matchLevel in checkWindow and override argument to openEyes', async () => {
    wrapper.checkWindow = async ({tag}) => {
      await psetTimeout(20);
      expect(wrapper.getMatchLevel()).to.equal(tag === 2 ? 'Layout' : 'Content');
    };
    const {checkWindow, close} = await openEyes({
      wrappers: [wrapper],
      appName,
      matchLevel: 'Content',
    });
    checkWindow({tag: 1, cdt: [], url: ''});
    await psetTimeout(0);
    checkWindow({matchLevel: 'Layout', tag: 2, cdt: [], url: ''});
    await psetTimeout(0);
    checkWindow({tag: 3, cdt: [], url: ''});
    await close();
  });

  it('sets matchLevel in checkWindow and override argument to makeRenderingGridClient', async () => {
    openEyes = makeRenderingGridClient({
      apiKey,
      showLogs: APPLITOOLS_SHOW_LOGS,
      renderWrapper: wrapper,
      matchLevel: 'Content',
    }).openEyes;

    wrapper.checkWindow = async ({tag}) => {
      await psetTimeout(20);
      expect(wrapper.getMatchLevel()).to.equal(tag === 2 ? 'Layout' : 'Content');
    };
    const {checkWindow, close} = await openEyes({
      apiKey,
      wrappers: [wrapper],
      appName,
    });
    checkWindow({tag: 1, cdt: [], url: ''});
    await psetTimeout(0);
    checkWindow({matchLevel: 'Layout', tag: 2, cdt: [], url: ''});
    await psetTimeout(0);
    checkWindow({tag: 3, cdt: [], url: ''});
    await close();
  });
});
