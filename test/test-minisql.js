/*
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

var assert = require('assert')
var events = require('events')
var net = require('net')
var qmock = require('qmock')
var minisql = require('../')

// from `qibl`
var allocBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.allocUnsafe : Buffer')
var fromBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.from : Buffer')
var noop = function(){}

var mockCreds = { host: 'localhost', port: 3306, database: 'test', user: 'user', password: 'password' }

describe('minisql', function() {
    var db, packman, packeteer, socket
    beforeEach(function(done) {
        db = minisql.createConnection(mockCreds)
        packman = db.packman
        packeteer = packman.packeteer
        socket = new events.EventEmitter()
        socket.setNoDelay = noop
        qmock.stubOnce(net, 'connect').returns(socket)
        done()
    })

    describe('_select', function() {
        it('calls query', function(done) {
            var spy

            spy = qmock.stubOnce(db, 'query')
            db._select('mock call 1', function(){})
            assert.ok(spy.called)
            assert.equal(spy.args[0][0], 'mock call 1')

            spy = qmock.stubOnce(db, 'query')
            db._select('mock call ?', [2], function(){})
            assert.ok(spy.called)
            assert.equal(spy.args[0][0], 'mock call ?')

            done()
        })
    })
})
