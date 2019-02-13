'use strict';
const {
  MatchResult,
  RenderStatusResults,
  RenderStatus,
  Location,
} = require('@applitools/eyes-sdk-core');
const {URL} = require('url');
const {loadJsonFixture, loadFixtureBuffer} = require('./loadFixture');
const SOME_BATCH = 'SOME_BATCH';
const getSha256Hash = require('./getSha256Hash');
const FakeRunningRender = require('./FakeRunningRender');
const EventEmitter = require('events');

let salt = 0;

function compare(o1, o2) {
  return JSON.stringify(o1) === JSON.stringify(o2);
}

const devices = {
  'iPhone 4': {width: 320, height: 480},
};

const selectorsToLocations = {
  sel1: {x: 1, y: 2, width: 3, height: 4},
  sel2: {x: 5, y: 6, width: 7, height: 8},
  sel3: {x: 100, y: 101, width: 102, height: 103},
  sel4: {x: 200, y: 201, width: 202, height: 203},
  sel5: {x: 300, y: 301, width: 302, height: 303},
  sel6: {x: 400, y: 401, width: 402, height: 403},
};

class FakeEyesWrapper extends EventEmitter {
  constructor({goodFilename, goodResourceUrls = [], goodTags, goodResources = []}) {
    super();
    this._logger = {
      verbose: console.log,
      log: console.log,
    };
    this.goodFilename = goodFilename;
    this.goodResourceUrls = goodResourceUrls;
    this.goodResources = goodResources;
    this.goodTags = goodTags;
    this.batch;
    this.baseUrl = 'http://fake';
    this.resultsRoute = '/results_url';
    this.matchLevel = 'Strict';
  }

  async open(_appName, _testName, _viewportSize) {
    this.results = [];
    return new Promise(res =>
      setTimeout(() => {
        this.emit('openEnd');
        res();
      }, 100),
    );
  }

  async renderBatch(renderRequests) {
    const renderInfo = renderRequests[0].getRenderInfo();
    this.sizeMode = renderInfo.getSizeMode();
    this.selector = renderInfo.getSelector();
    this.region = renderInfo.getRegion();
    this.emulationInfo = renderInfo.getEmulationInfo();
    this.selectorsToFindRegionsFor = renderRequests[0].getSelectorsToFindRegionsFor();

    return renderRequests.map(renderRequest => this.getRunningRenderForRequest(renderRequest));
  }

  getRunningRenderForRequest(renderRequest) {
    const resources = renderRequest.getResources();
    const actualResources = resources.map(resource => ({
      url: resource.getUrl(),
      hash: resource.getSha256Hash(),
    }));
    const isGoodResources =
      !actualResources.length ||
      this.expectedResources.every(er => !!actualResources.find(ar => compare(er, ar)));

    const cdt = renderRequest.getDom().getDomNodes();
    const isGoodCdt = cdt.length === 0 || compare(cdt, this.expectedCdt); // allowing [] for easier testing (only need to pass `cdt:[]` in the test)
    const renderInfo = renderRequest.getRenderInfo();
    const sizeMode = renderInfo.getSizeMode();
    const browserName = renderRequest.getBrowserName();
    const selector = renderInfo.getSelector();
    const region = renderInfo.getRegion();
    const emulationInfo = renderInfo.getEmulationInfo();
    const selectorsToFindRegionsFor = renderRequest.getSelectorsToFindRegionsFor();

    const isGood = isGoodCdt && isGoodResources;
    const renderId = JSON.stringify({
      isGood,
      region,
      browserName,
      selector,
      sizeMode,
      emulationInfo,
      selectorsToFindRegionsFor,
      salt: salt++,
    });

    return new FakeRunningRender(renderId, RenderStatus.RENDERED);
  }

  async getRenderStatus(renderIds) {
    return renderIds.map(renderId => {
      const {browserName, emulationInfo, selectorsToFindRegionsFor} = JSON.parse(renderId);
      return new RenderStatusResults({
        status: RenderStatus.RENDERED,
        imageLocation: renderId,
        userAgent: browserName,
        deviceSize: emulationInfo && emulationInfo.deviceName && devices[emulationInfo.deviceName],
        selectorRegions: selectorsToFindRegionsFor
          ? selectorsToFindRegionsFor.map(selector => selectorsToLocations[selector])
          : undefined,
      });
    });
  }

  async getRenderInfo() {
    return {getResultsUrl: () => `${this.baseUrl}${this.resultsRoute}`};
  }

  setRenderingInfo(val) {
    this.renderingInfo = val;
  }

  async putResource() {}

  async checkWindow({screenshotUrl, tag, domUrl, checkSettings, imageLocation}) {
    if (tag && this.goodTags && !this.goodTags.includes(tag))
      throw new Error(`Tag ${tag} should be one of the good tags ${this.goodTags}`);

    const result = new MatchResult();
    const {
      isGood,
      sizeMode,
      browserName: _browserName,
      selector,
      region,
      emulationInfo,
      selectorsToFindRegionsFor,
    } = JSON.parse(screenshotUrl);

    const expectedImageLocation =
      sizeMode === 'selector'
        ? new Location(selectorsToLocations[selectorsToFindRegionsFor[0]])
        : undefined;

    const asExpected =
      isGood &&
      (!this.sizeMode || sizeMode === this.sizeMode) &&
      (!this.selector || selector === this.selector) &&
      compare(region, this.region) &&
      compare(emulationInfo, this.emulationInfo) &&
      compare(selectorsToFindRegionsFor, this.selectorsToFindRegionsFor) &&
      compare(imageLocation, expectedImageLocation);

    result.setAsExpected(asExpected);

    result.__domUrl = domUrl;
    result.__checkSettings = checkSettings;
    result.__tag = tag;
    this.results.push(result);
    return new Promise(res =>
      setTimeout(() => {
        this.emit('checkWindowEnd');
        res(result);
      }, 100),
    );
  }

  createRGridDom({cdt: _cdt, resources: _resources}) {}

  async close() {
    this.emit('closed');
    this.closed = !this.aborted;
    if (this.results.find(r => !r.getAsExpected())) throw new Error('mismatch');
    return this.results;
  }

  async abortIfNotClosed() {
    this.emit('aborted');
    this.aborted = !this.closed;
  }

  get expectedCdt() {
    return loadJsonFixture(this.goodFilename);
  }

  get expectedResources() {
    const urlResources = this.goodResourceUrls.map(resourceUrl => ({
      url: resourceUrl,
      hash: getSha256Hash(loadFixtureBuffer(new URL(resourceUrl).pathname.slice(1))),
    }));

    const recs = this.goodResources.map(resource => ({
      url: resource.url,
      //content: resource.content,
      hash: getSha256Hash(resource.content),
    }));
    return [...urlResources, ...recs];
  }

  getBatch() {
    return this.batch || SOME_BATCH;
  }

  setBatch(batch) {
    this.batch = batch;
  }

  setBaselineBranchName(value) {
    this.baselineBranchName = value;
  }

  setBaselineEnvName(value) {
    this.baselineEnvName = value;
  }

  setBaselineName(value) {
    this.baselineName = value;
  }

  setEnvName(value) {
    this.envName = value;
  }

  setIgnoreCaret(value) {
    this.ignoreCaret = value;
  }

  setIsDisabled(value) {
    this.isDisabled = value;
  }

  setMatchLevel(value) {
    this.matchLevel = value;
  }

  getMatchLevel() {
    return this.matchLevel;
  }

  setMatchTimeout(value) {
    this.matchTimeout = value;
  }

  setParentBranchName(value) {
    this.parentBranchName = value;
  }

  setBranchName(value) {
    this.branchName = value;
  }

  setProxy(value) {
    this.proxy = value;
  }

  setSaveFailedTests(value) {
    this.saveFailedTests = value;
  }

  setSaveNewTests(value) {
    this.saveNewTests = value;
  }

  setCompareWithParentBranch(value) {
    this.compareWithParentBranch = value;
  }

  setIgnoreBaseline(value) {
    this.ignoreBaseline = value;
  }

  setServerUrl(value) {
    this.serverUrl = value;
  }

  async getInferredEnvironment() {
    return this.inferredEnvironment;
  }

  setInferredEnvironment(value) {
    this.inferredEnvironment = value;
  }

  setViewportSize(value) {
    this.viewportSize = value;
  }

  setDeviceInfo(value) {
    this.deviceInfo = value;
  }

  setBaseAgentId(value) {
    this.agentId = value;
  }

  getApiKey() {
    return this.apiKey;
  }

  setApiKey(value) {
    this.apiKey = value;
  }
}

module.exports = FakeEyesWrapper;
module.exports.selectorsToLocations = selectorsToLocations;
module.exports.devices = devices;
