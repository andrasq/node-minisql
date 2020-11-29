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
        qmock.stubOnce(net, 'connect', function() {
            setImmediate(function() { socket.emit('connect') })
            return socket
        })
        done()
    })

    describe('Packeteer', function() {
        it('tallies total length', function(done) {
            packeteer.write(fromBuf("abc"))
            assert.equal(packeteer.nbytes, 3)
            packeteer.write(fromBuf("defghi"))
            assert.equal(packeteer.nbytes, 9)
            done()
        })
        it('grows first packet to 5', function(done) {
            packeteer.write(fromBuf([1, 0, 0]))
            packeteer.write(fromBuf([4]))
            packeteer.write(fromBuf([5, 6]))
            assert.equal(packeteer.bufs.length, 1)
            packeteer.write(fromBuf([7, 8]))
            assert.equal(packeteer.bufs.length, 2)
            assert.deepEqual(packeteer.bufs[0], [1, 0, 0, 4, 5, 6])
            assert.deepEqual(packeteer.bufs[1], [7, 8])
            done()
        })
    })

    describe('Packman', function() {
        beforeEach(function(done) {
            packman.connect({}, function() {
                done()
            })
        })
        it('gathers first socket error', function(done) {
            assert.equal(packman.error, null)
            socket.emit('error', 'mock-error-1')
            assert.equal(packman.error, 'mock-error-1')
            socket.emit('error', 'mock-error-2')
            assert.equal(packman.error, 'mock-error-1')
            done()
        })
        it('end calls socket.end', function(done) {
            var spy = qmock.stub(socket, 'end', function() { socket.emit('close') })
            packman.end()
            assert.ok(spy.called)
            done()
        })
        it('end calls callback', function(done) {
            var spy = qmock.stub(socket, 'end', function() { socket.emit('close') })
            packman.end(function(err) {
                done()
            })
        })
        it('end just returns existing error', function(done) {
            var spy = qmock.stub(socket, 'end')
            packman.error = 'mock error'
            packman.end(function(err) {
                assert.equal(err, 'mock error')
                assert.ok(!spy.called)
                done()
            })
        })
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
