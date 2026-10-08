'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function dashboard(saved = null) {
  const requests = [];
  const errors = [];
  const handlers = {};
  const frames = [];
  const list = { scrollTop: 230 };
  let storage = saved;
  let scroll;
  let socket;
  const context = vm.createContext({
    console: { log() {}, error: error => errors.push(error) },
    document: { location: { host: 'localhost' }, addEventListener() {}, getElementById: () => list },
    window: {
      sessionStorage: { getItem: () => storage, setItem: (key, value) => { storage = value; } },
      addEventListener: (name, fn) => { handlers[name] = fn; },
      requestAnimationFrame: fn => frames.push(fn),
      scrollX: 5, scrollY: 420,
      scrollTo: (x, y) => { scroll = [x, y]; }
    },
    WebSocket: function () { socket = this; },
    $: () => ({ tooltip() {}, text: () => '' }),
    ElemuBootstrapUtils: function () {},
    ElemuWebApi: function () {},
    VueRouter: function (options) {
      this.options = options;
      this.currentRoute = { path: '/home' };
      this.beforeEach = this.push = () => {};
    },
    Vue: function () { this.$mount = () => this; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../html/elemu.js'), 'utf8'), context);
  const app = new context.Elemu();
  const air = [{ epc: '80', edt: { hex: '30' } }, { epc: 'B3', edt: { hex: '19' } }];
  const node = [{ epc: '80', edt: { hex: '30' } }];
  app._edt_value_data = { '013001': air, '0EF001': node };
  const panel = app.components_bind_data['eoj-panel'];
  panel.eoj = '013001';
  panel.epc_list = air;
  app._webapi = {
    getDeviceEpcs: eoj => new Promise((resolve, reject) => requests.push({ eoj, resolve, reject }))
  };
  app.initWs();
  return {
    app, panel, air, node, requests, errors, socket, context, handlers, frames, list,
    storage: () => storage,
    scroll: () => scroll,
    notify: eoj => socket.onmessage({ data: JSON.stringify({ event: 'epcupdated', data: { eoj } }) })
  };
}

function response(properties) {
  return { data: { elProperties: properties } };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

test('device update notification changes decoded values without replacing the selection, list, or rows', async () => {
  const d = dashboard();
  const row = d.air[1];
  d.notify('013001');
  assert.equal(d.requests.length, 1);
  assert.equal(d.requests[0].eoj, '013001');
  const edt = { hex: '1A', data: { type: 'number', number: { value: 26, unit: '°C' } } };
  d.requests[0].resolve(response([{ epc: 'B3', edt }]));
  await settle();
  assert.equal(row.edt, edt);
  assert.equal(d.panel.eoj, '013001');
  assert.equal(d.panel.epc_list, d.air);
  assert.equal(d.air[1], row);
  assert.equal(d.air[0].edt.hex, '30');
  assert.equal(d.node[0].edt.hex, '30');
});

test('out-of-order responses cannot overwrite the newest values', async () => {
  const d = dashboard();
  d.notify('013001');
  d.notify('013001');
  d.requests[1].resolve(response([{ epc: '80', edt: { hex: '31' } }, { epc: 'B3', edt: { hex: '1A' } }]));
  await settle();
  d.requests[0].resolve(response([{ epc: '80', edt: { hex: '30' } }, { epc: 'B3', edt: { hex: '19' } }]));
  await settle();
  assert.equal(d.air[0].edt.hex, '31');
  assert.equal(d.air[1].edt.hex, '1A');
});

test('updates to a device in the background do not change the displayed device', async () => {
  const d = dashboard();
  d.notify('0EF001');
  d.requests[0].resolve(response([{ epc: '80', edt: { hex: '31' } }]));
  await settle();
  assert.equal(d.node[0].edt.hex, '31');
  assert.equal(d.panel.eoj, '013001');
  assert.equal(d.panel.epc_list, d.air);
});

test('a response from before a dashboard reload cannot change the replacement data', async () => {
  const d = dashboard();
  d.notify('013001');
  const replacement = [{ epc: '80', edt: { hex: '31' } }];
  d.app._edt_value_data['013001'] = replacement;
  d.requests[0].resolve(response([{ epc: '80', edt: { hex: '30' } }]));
  await settle();
  assert.equal(replacement[0].edt.hex, '31');
});

test('unknown devices and failed reads leave the current values usable', async () => {
  const d = dashboard();
  d.notify('FFFF01');
  assert.equal(d.requests.length, 0);
  d.notify('013001');
  const error = new Error('Disconnected');
  d.requests[0].reject(error);
  await settle();
  assert.equal(d.errors[0], error);
  assert.equal(d.air[0].edt.hex, '30');
  d.notify('013001');
  d.requests[1].resolve(response([{ epc: '80', edt: { hex: '31' } }]));
  await settle();
  assert.equal(d.air[0].edt.hex, '31');
});

test('WebSocket reconnection refreshes devices changed while disconnected', async () => {
  const d = dashboard();
  d.socket.onopen();
  assert.deepEqual(d.requests.map(request => request.eoj).sort(), ['013001', '0EF001']);
  d.requests.forEach(request => request.resolve(response([{ epc: '80', edt: { hex: '31' } }])));
  await settle();
  assert.equal(d.air[0].edt.hex, '31');
  assert.equal(d.node[0].edt.hex, '31');
  assert.equal(d.panel.epc_list, d.air);
});

test('manual value reload cannot lose a change notification received during its read', async () => {
  const d = dashboard();
  let finish;
  d.app.getDeviceAllEdtData = () => new Promise(resolve => { finish = resolve; });
  d.app.modalLoadingShow = d.app.modalLoadingClose = () => {};
  d.app.eojPanelReloadEdt();
  d.notify('013001');
  d.requests[0].resolve(response([{ epc: 'B3', edt: { hex: '1A' } }]));
  await settle();
  const replacement = [{ epc: 'B3', edt: { hex: '19' } }];
  finish({ '013001': replacement, '0EF001': d.node });
  await settle();
  assert.equal(d.requests.length, 2);
  d.requests[1].resolve(response([{ epc: 'B3', edt: { hex: '1A' } }]));
  await settle();
  assert.equal(d.panel.epc_list, replacement);
  assert.equal(replacement[0].edt.hex, '1A');
  assert.equal(d.panel.eoj, '013001');
});

async function initialize(d, eojs = ['0EF001', '013001']) {
  d.app.modalLoadingShow = d.app.modalLoadingClose = d.app.applyLang = () => {};
  d.app._webapi.getPowerStatus = async () => ({ data: { powerStatus: true } });
  d.app._webapi.getLang = async () => ({ data: { lang: 'ja' } });
  d.app._webapi.getReleaseVersionList = async () => ({ data: { releaseList: [] } });
  d.app._webapi.getDevcieDescriptionDeviceList = async () => ({ data: { deviceList: [] } });
  d.app.getEojList = async () => eojs.map(eoj => ({ eoj }));
  d.app.getRemoteDeviceList = async () => ({ remoteDeviceList: [] });
  d.app.initViews();
  d.app.initDashboard();
  await settle();
}

test('a notification before initialization finishes is reflected in the new dashboard', async () => {
  const d = dashboard();
  d.app._edt_value_data = {};
  let finish;
  d.app.getDeviceAllEdtData = () => new Promise(resolve => { finish = resolve; });
  await initialize(d);
  d.notify('013001');
  assert.equal(d.requests.length, 0);
  finish({ '013001': d.air, '0EF001': d.node });
  await settle();
  assert.equal(d.requests.length, 1);
  d.requests[0].resolve(response([{ epc: 'B3', edt: { hex: '1A' } }]));
  await settle();
  assert.equal(d.air[1].edt.hex, '1A');
});

test('page reload saves the device, property scroll, and page scroll', () => {
  const d = dashboard();
  d.app.initViews = d.app.initWs = () => {};
  d.app.init();
  d.handlers.pagehide();
  assert.deepEqual(JSON.parse(d.storage()), { eoj: '013001', scrollTop: 230, windowX: 5, windowY: 420 });
  d.context.window.sessionStorage.setItem = () => { throw new Error('Storage disabled'); };
  assert.doesNotThrow(() => d.handlers.pagehide());
});

test('page reload restores the saved device and scroll after the panel mounts', async () => {
  const d = dashboard(JSON.stringify({ eoj: '013001', scrollTop: 230, windowX: 5, windowY: 420 }));
  d.panel.eoj = '';
  d.app.getDeviceAllEdtData = async () => ({ '013001': d.air, '0EF001': d.node });
  await initialize(d);
  assert.equal(d.panel.eoj, '013001');
  const component = d.app.router.options.routes.find(route => route.path === '/home').component.components['eoj-panel'];
  d.list.scrollTop = 0;
  component.mounted.call({ eoj: d.panel.eoj, $nextTick: fn => fn(), $el: { querySelector: () => d.list } });
  d.frames.forEach(fn => fn());
  assert.equal(d.list.scrollTop, 230);
  assert.deepEqual(d.scroll(), [5, 420]);
  assert.equal(d.app._saved_eoj_panel, null);
});

test('a deleted saved device falls back to the existing device without restoring its old scroll', async () => {
  const d = dashboard(JSON.stringify({ eoj: '013001', scrollTop: 230, windowX: 5, windowY: 420 }));
  d.panel.eoj = '';
  d.app.getDeviceAllEdtData = async () => ({ '0EF001': d.node });
  await initialize(d, ['0EF001']);
  assert.equal(d.panel.eoj, '0EF001');
  const component = d.app.router.options.routes.find(route => route.path === '/home').component.components['eoj-panel'];
  component.mounted.call({ eoj: d.panel.eoj });
  assert.equal(d.frames.length, 0);
});

test('invalid saved JSON and unavailable storage do not stop the dashboard from loading', () => {
  const d = dashboard('{invalid');
  assert.equal(d.app._saved_eoj_panel, null);
  d.context.window.sessionStorage.getItem = () => { throw new Error('Storage disabled'); };
  assert.equal(new d.context.Elemu()._saved_eoj_panel, null);
});

test('scroll restoration does not move a different page entered before the next frame', () => {
  const d = dashboard(JSON.stringify({ eoj: '013001', scrollTop: 230, windowX: 5, windowY: 420 }));
  d.app.initViews();
  const component = d.app.router.options.routes.find(route => route.path === '/home').component.components['eoj-panel'];
  component.mounted.call({ eoj: d.panel.eoj, $nextTick: fn => fn(), $el: { querySelector: () => d.list } });
  d.app.router.currentRoute = { path: '/editEdt/013001/B3' };
  d.frames.forEach(fn => fn());
  assert.equal(d.scroll(), undefined);
});
