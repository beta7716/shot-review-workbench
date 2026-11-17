import test from 'node:test';
import assert from 'node:assert/strict';
import {allowLocalRequest} from '../lib/request-guard.mjs';

test('loopback requests work and hostile Host/Origin are refused',()=>{
  const req = headers=>({headers});
  assert.equal(allowLocalRequest(req({host:'127.0.0.1:4318'}),4318),true);
  assert.equal(allowLocalRequest(req({host:'localhost:4318',origin:'http://localhost:4318'}),4318),true);
  assert.equal(allowLocalRequest(req({host:'hostile.example:4318'}),4318),false);
  assert.equal(allowLocalRequest(req({host:'127.0.0.1:4318',origin:'https://hostile.example'}),4318),false);
  assert.equal(allowLocalRequest(req({host:'127.0.0.1:4318',origin:'http://localhost:4317'}),4318),false);
  assert.equal(allowLocalRequest(req({host:'127.0.0.1:4318','sec-fetch-site':'cross-site'}),4318),false);
});
