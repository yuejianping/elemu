'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const composer = require('../lib/PacketComposer.js');
const PacketParser = require('../lib/PacketParser.js');
const DeviceObject = require('../lib/DeviceObject.js');
const DeviceState = require('../lib/DeviceState.js');
const Device = require('../lib/Device.js');
const mMra = require('../lib/Mra.js');

const descriptions = {
  getEoj() {
    return {
      className: 'test',
      elProperties: {}
    };
  }
};

const parser = new PacketParser(descriptions, {});

function compose(params) {
  const buf = composer.compose(params);
  assert.ok(buf, composer.error && composer.error.message);
  return buf;
}

function setGetParams(esv) {
  return {
    tid: 0x0176,
    seoj: esv === '6E' ? '05FF01' : '013001',
    deoj: esv === '6E' ? '013001' : '05FF01',
    esv,
    properties: [{ epc: '80', edt: esv === '6E' ? '30' : null }],
    properties2: [{ epc: '80', edt: esv === '6E' ? null : '31' }]
  };
}

test('SetGet request is composed with OPCSet and OPCGet', () => {
  const buf = compose(setGetParams('6E'));
  assert.equal(buf.toString('hex').toUpperCase(), '1081017605FF010130016E01800130018000');
});

test('SetGet_RES uses PDC=0 for a successful SET and returns the GET value', () => {
  const buf = compose(setGetParams('7E'));
  assert.equal(buf.toString('hex').toUpperCase(), '1081017601300105FF017E01800001800131');
});

test('SetGet_SNA is the only ESV that permits empty property groups', () => {
  const buf = compose({
    tid: 0x0176,
    seoj: '013001',
    deoj: '05FF01',
    esv: '5E',
    properties: [],
    properties2: []
  });
  assert.equal(buf.toString('hex').toUpperCase(), '1081017601300105FF015E0000');

  assert.equal(composer.compose({
    tid: 1,
    seoj: '05FF01',
    deoj: '013001',
    esv: '6E',
    properties: [],
    properties2: [{ epc: '80' }]
  }), null);
  assert.match(composer.error.message, /at least one/);

  assert.equal(composer.compose({
    tid: 1,
    seoj: '05FF01',
    deoj: '013001',
    esv: '62',
    properties: []
  }), null);
  assert.match(composer.error.message, /at least one/);
});

test('parser round-trips both SetGet property groups', () => {
  const parsed = parser.parse(compose(setGetParams('6E')));
  assert.equal(parsed.result, 0);
  assert.equal(parsed.data.data.opc.value, 1);
  assert.equal(parsed.data.data.properties[0].edt.hex, '30');
  assert.equal(parsed.data.data.opc2.value, 1);
  assert.equal(parsed.data.data.properties2[0].edt.hex, null);
});

test('parser accepts OPCSet=0 and OPCGet=0 only for SetGet_SNA', () => {
  const sna = parser.parse(Buffer.from('1081017601300105FF015E0000', 'hex'));
  assert.equal(sna.result, 0);
  assert.equal(sna.data.data.opc.value, 0);
  assert.equal(sna.data.data.opc2.value, 0);

  const zeroSet = parser.parse(Buffer.from('1081017605FF010130016E00018000', 'hex'));
  assert.equal(zeroSet.err, 'OPC_ZERO');

  const zeroGet = parser.parse(Buffer.from('1081017605FF010130016E0180013000', 'hex'));
  assert.equal(zeroGet.err, 'OPC_ZERO');
});

test('parser rejects a missing second group, count mismatch, and trailing bytes', () => {
  const missingGet = parser.parse(Buffer.from('1081017605FF010130016E01800130', 'hex'));
  assert.equal(missingGet.err, 'OPC_GET_MISSING');

  const overflow = parser.parse(Buffer.from('1081017605FF010130016E02800130018000', 'hex'));
  assert.equal(overflow.err, 'EDT_MISSING');

  const trailing = parser.parse(Buffer.from('1081017605FF010130016E01800130018000FF', 'hex'));
  assert.equal(trailing.err, 'PACKET_TRAILING_BYTES');
});

function createDeviceObject() {
  const object = new DeviceObject('013001', {}, {}, {}, {}, 'M', parser, {});
  object._getSetDelayMsec = () => 0;
  object._getResponseWaitMsec = () => 0;
  return object;
}

function receiveSetGet(object, packet) {
  return new Promise((resolve) => {
    object.onsend = (address, response) => resolve({ address, response });
    object._receiveReqSetGet('192.0.2.1', packet);
  });
}

const requestPacket = {
  tid: 0x0176,
  seoj: '05FF01',
  deoj: '013001',
  esv: '6E',
  properties: [{ epc: '80', edt: '30' }],
  properties2: [{ epc: '80', edt: null }]
};

test('DeviceObject completes SET before GET and returns SetGet_RES', async () => {
  const object = createDeviceObject();
  const order = [];
  object.setEpcValues = async () => {
    order.push('set');
    return { result: 0, vals: { 80: null } };
  };
  object._states = {
    getEpcValues: async () => {
      order.push('get');
      return { result: 0, vals: { 80: '31' } };
    }
  };

  const { response } = await receiveSetGet(object, requestPacket);
  assert.deepEqual(order, ['set', 'get']);
  assert.equal(response.esv, '7E');
  assert.deepEqual(response.properties, [{ epc: '80', edt: null }]);
  assert.deepEqual(response.properties2, [{ epc: '80', edt: '31' }]);
});

test('DeviceObject returns per-property SetGet_SNA values on validation failure', async () => {
  const object = createDeviceObject();
  object.setEpcValues = async () => ({ result: 1, vals: { 80: '30' } });
  object._states = {
    getEpcValues: async () => ({ result: 0, vals: { 80: '31' } })
  };

  const { response } = await receiveSetGet(object, requestPacket);
  assert.equal(response.esv, '5E');
  assert.deepEqual(response.properties, [{ epc: '80', edt: '30' }]);
  assert.deepEqual(response.properties2, [{ epc: '80', edt: '31' }]);
});

test('DeviceObject returns SetGet_SNA with OPCSet=0 and OPCGet=0 on internal failure', async () => {
  const object = createDeviceObject();
  object.setEpcValues = async () => {
    throw new Error('test failure');
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const { response } = await receiveSetGet(object, requestPacket);
    assert.equal(response.esv, '5E');
    assert.deepEqual(response.properties, []);
    assert.deepEqual(response.properties2, []);
    assert.equal(compose(response).toString('hex').toUpperCase(), '1081017601300105FF015E0000');
  } finally {
    console.error = originalError;
  }
});

test('real home-air-conditioner metadata validates EDT by EPC', async () => {
  const aircon = mMra.getEoj('0130');
  const state = new DeviceState('013001', aircon, {}, {}, mMra.getRelease(), parser, {});
  state._property_map = {
    80: { get: true, set: true, inf: true }
  };
  state._states = { 80: '31' };
  state._writeStateFile = async () => {};

  const valid = await state.setEpcValues([{ epc: '80', edt: '30' }], false, 0);
  assert.equal(valid.result, 0);
  assert.equal(valid.vals['80'], null);

  const invalid = await state.setEpcValues([{ epc: '80', edt: '28' }], false, 0);
  assert.equal(invalid.result, 1);
  assert.equal(invalid.vals['80'], '28');
});

test('real home-air-conditioner metadata rejects unsupported EPC access', async () => {
  const aircon = mMra.getEoj('0130');
  const state = new DeviceState('013001', aircon, {}, {}, mMra.getRelease(), parser, {});
  state._property_map = {};
  state._states = {};

  const setResult = await state.setEpcValues([{ epc: 'FF', edt: '01' }], false, 0);
  const getResult = await state.getEpcValues([{ epc: 'FF', edt: null }], false);
  assert.equal(setResult.result, 1);
  assert.equal(getResult.result, 1);
  assert.equal(setResult.vals.FF, '01');
  assert.equal(getResult.vals.FF, null);
});

test('TX monitor event is emitted only after the exact UDP buffer is sent', async () => {
  const buf = compose(setGetParams('6E'));
  const parsed = {
    result: 0,
    data: {
      hex: 'test',
      data: {
        seoj: { hex: '05FF01' }
      }
    }
  };
  let finishSend;
  let sentBuffer;
  let monitorEvent = null;
  const fakeDevice = {
    _power_status: true,
    _parser: { parse: (value) => {
      assert.strictEqual(value, buf);
      return parsed;
    } },
    _current_eoj_list: [],
    _conf: { 'console-packet': false },
    _console: {},
    _packet_logger: null,
    _packet_sender: {
      send: (address, value) => {
        sentBuffer = value;
        return new Promise((resolve) => {
          finishSend = () => resolve(address);
        });
      }
    },
    onsent: (address, value) => {
      monitorEvent = { address, value };
    }
  };

  const pending = Device.prototype.send.call(fakeDevice, '192.0.2.1', buf);
  assert.strictEqual(sentBuffer, buf);
  assert.equal(monitorEvent, null);
  finishSend();
  await pending;
  assert.deepEqual(monitorEvent, { address: '192.0.2.1', value: parsed });
});
