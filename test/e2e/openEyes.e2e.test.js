'use strict';

const {describe, it, before, after, beforeEach} = require('mocha');
const {expect} = require('chai');
const puppeteer = require('puppeteer');
const makeRenderingGridClient = require('../../src/sdk/renderingGridClient');
const testServer = require('../util/testServer');
const {DiffsFoundError} = require('@applitools/eyes-sdk-core');
const {getProcessPageAndSerializeScript} = require('@applitools/dom-snapshot');
const fs = require('fs');
const {resolve} = require('path');

describe('openEyes', () => {
  let baseUrl, closeServer, openEyes;
  const apiKey = process.env.APPLITOOLS_API_KEY; // TODO bad for tests. what to do
  let browser, page;
  let processPageAndSerialize;

  beforeEach(() => {
    openEyes = makeRenderingGridClient(
      Object.assign({showLogs: process.env.APPLITOOLS_SHOW_LOGS, apiKey}),
    ).openEyes;
  });

  before(async () => {
    if (!apiKey) {
      throw new Error('APPLITOOLS_API_KEY env variable is not defined');
    }
    const server = await testServer({port: 3456}); // TODO fixed port avoids 'need-more-resources' for dom. Is this desired? should both paths be tested?
    baseUrl = `http://localhost:${server.port}`;
    closeServer = server.close;

    browser = await puppeteer.launch();
    page = await browser.newPage();

    await page.setCookie({name: 'auth', value: 'secret', url: baseUrl});

    const processPageAndSerializeScript = await getProcessPageAndSerializeScript();
    processPageAndSerialize = () => page.evaluate(`(${processPageAndSerializeScript})()`);
  });

  after(async () => {
    await closeServer();
    await browser.close();
  });

  before(async () => {
    if (process.env.APPLITOOLS_UPDATE_FIXTURES) {
      await page.goto(`${baseUrl}/test.html`);
      const {cdt} = await processPageAndSerialize();

      for (const el of cdt) {
        const attr = el.attributes && el.attributes.find(x => x.name === 'data-blob');
        if (attr) {
          if (el.nodeName === 'LINK') {
            const hrefAttr = el.attributes.find(x => x.name === 'href');
            hrefAttr.value = attr.value;
          }

          if (el.nodeName === 'IMG') {
            const srcAttr = el.attributes.find(x => x.name === 'src');
            srcAttr.value = attr.value;
          }
        }
      }

      const cdtStr = JSON.stringify(cdt, null, 2);
      fs.writeFileSync(resolve(__dirname, '../fixtures/test.cdt.json'), cdtStr);
    }
  });

  it('passes with correct screenshot', async () => {
    await page.goto(`${baseUrl}/test.html`);

    const {cdt, url, blobs, resourceUrls} = await processPageAndSerialize();

    const resourceContents = blobs.map(({url, type, value}) => ({
      url,
      type,
      value: Buffer.from(value, 'base64'),
    }));

    const {checkWindow, close} = await openEyes({
      appName: 'some app',
      testName: 'passes with correct screenshot',
      browser: [
        {width: 640, height: 480, name: 'chrome'},
        {width: 800, height: 600, name: 'firefox'},
        {deviceName: 'iPhone X'},
      ],
      showLogs: process.env.APPLITOOLS_SHOW_LOGS,
      saveDebugData: process.env.APPLITOOLS_SAVE_DEBUG_DATA,
    });

    const scriptHooks = {
      beforeCaptureScreenshot: "document.body.style.backgroundColor = 'gold'",
    };

    checkWindow({
      resourceUrls,
      resourceContents,
      cdt,
      tag: 'first',
      url,
      scriptHooks,
    });

    await close();
  });

  it('fails with incorrect screenshot', async () => {
    await page.goto(`${baseUrl}/test.html`);

    const {cdt, url, blobs, resourceUrls} = await processPageAndSerialize();

    const resourceContents = blobs.map(({url, type, value}) => ({
      url,
      type,
      value: Buffer.from(value, 'base64'),
    }));

    const {checkWindow, close} = await openEyes({
      appName: 'some app',
      testName: 'fails with incorrect screenshot',
      browser: [
        {width: 640, height: 480, name: 'chrome'},
        {width: 800, height: 600, name: 'firefox'},
        {deviceName: 'iPhone X'},
      ],
      showLogs: process.env.APPLITOOLS_SHOW_LOGS,
      saveDebugData: process.env.APPLITOOLS_SAVE_DEBUG_DATA,
    });

    const scriptHooks = {
      beforeCaptureScreenshot: "document.body.style.backgroundColor = 'gold'",
    };

    cdt.find(node => node.nodeValue === "hi, I'm red").nodeValue = "hi, I'm green";

    checkWindow({
      resourceUrls,
      resourceContents,
      cdt,
      tag: 'first',
      url,
      scriptHooks,
    });

    expect(await close().then(() => 'ok', err => err)).to.be.instanceOf(DiffsFoundError);
  });
});
