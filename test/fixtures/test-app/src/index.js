/* eslint-disable */
const fs = require('fs');
const url = require('url');
url.URL = URL;
fs.open = () => {};
process.hrtime = require('browser-process-hrtime');
window.Buffer = require('buffer').Buffer;
window.makeRenderingGridClient = require('../../../../src/sdk/renderingGridClient');
