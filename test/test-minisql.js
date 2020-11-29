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

var setImmediate = global.setImmediate || process.nextTick

// from `qibl`
var allocBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.alloc : Buffer')
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
            assert.deepEqual(packeteer.bufs[0], fromBuf([1, 0, 0, 4, 5, 6]))
            assert.deepEqual(packeteer.bufs[1], fromBuf([7, 8]))
            done()
        })
    })

    describe('Packman', function() {
        beforeEach(function(done) {
            packman.connect({}, function() {
                done()
            })
        })
        it('connect calls its callback', function(done) {
            qmock.stubOnce(net, 'connect', function() { setImmediate(function() { socket.emit('connect') }); return socket })
            var _socket = packman.connect({}, function() {
                assert.equal(_socket, socket)
                done()
            })
        })
        it('connect callback is optional', function(done) {
            socket = new events.EventEmitter()
            socket.setNoDelay = noop
            qmock.stubOnce(net, 'connect', function() { setImmediate(function() { socket.emit('connect') }); return socket })
            packman.connect({})
            // wait for the connect event to see the built-in callback invoked
            setImmediate(done)
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
        it('getPacket returns waiting packet', function(done) {
            var myPacket = fromBuf([1, 0, 0, 1, 99])
            packman._socket.emit('data', myPacket)
            packman.getPacket(function(err, packet) {
                assert.equal(packet, myPacket)
                done()
            })
        })
        it('getPacket waitlists caller to call once no packet is ready', function(done) {
            var myPacket = fromBuf([2, 0, 0, 1, 99])
            packman._socket.emit('data', myPacket)
            var cb = function(err, packet) {
                assert.deepEqual(packet, fromBuf([2, 0, 0, 1, 99, 100]))
                done()
            }
            packman.getPacket(cb)
            assert.equal(packman.waitlist.length, 1)
            assert.equal(packman.waitlist[0], cb)
            packman._socket.emit('data', fromBuf([100]))
        })
        it('getPacket concatenates packet chunks', function(done) {
            packman._socket.emit('data', fromBuf([3, 0, 0, 1]))
            packman._socket.emit('data', fromBuf([1, 2, 3, 4, 5]))
            packman.getPacket(function(err, packet) {
                assert.deepEqual(packet, fromBuf([3, 0, 0, 1, 1, 2, 3]))
                done()
            })
        })
        it('getPacket returns waiting packets then waiting error', function(done) {
            packman.error = new Error('mock error')
            packman.packets.push('mock packet')
            packman.getPacket(function(err, packet) {
                assert.equal(packet, 'mock packet')
                packman.getPacket(function(err, packet) {
                    assert.equal(packet[4], 0xff)
                    done()
                })
            })
        })
        it('_getResponse combines large packets', function(done) {
            var packet = allocBuf(0xffffff + 100)
            var header1 = fromBuf([255, 255, 255, 3])
            var header2 = fromBuf([100, 0, 0, 4])
            packman._socket.emit('data', header1)
            packman._socket.emit('data', packet.slice(0, 0xffffff))
            packman._socket.emit('data', header2)
            packman._socket.emit('data', packet.slice(0xffffff))
            var buf = packman._getResponse()
            assert.equal(buf[3], 3)
            assert.equal(buf.length, 4 + 0xffffff + 100)
            done()
        })
        it('_getResponse verifies consecutive packet sequence ids', function(done) {
            var packet = allocBuf(0xffffff + 100)
            var header1 = fromBuf([255, 255, 255, 3])
            var header2 = fromBuf([100, 0, 0, 5])
            packman._socket.emit('data', header1)
            packman._socket.emit('data', packet.slice(0, 0xffffff))
            packman._socket.emit('data', header2)
            packman._socket.emit('data', packet.slice(0xffffff))
            var buf = packman._getResponse()
            assert.equal(buf[3], 0xff) // error packet
            // extract info string from the error packet
            var message = buf.toString('utf8', 11)
            assert.ok(/out of order/.test(message))
            done()
        })
        it('sendPacket writes packet with given sequence id', function(done) {
            var written = []
            socket.write = function(chunk) { written.push(chunk) }
            packman.sendPacket([1, 0, 0, 1, 77], 3)
            assert.deepEqual(written[0], fromBuf([1, 0, 0, 3, 77]))
            done()
        })
        it('sendPacket splits overlong packets and returns next unused sequence id', function(done) {
            var written = []
            var message = allocBuf(4 + 0xffffff + 100)
            message[4] = 111
            message[4 + 0xffffff] = 222
            socket.write = function(chunk) { written.push(chunk) }
            var nextSeqId = packman.sendPacket(message, 99)
            // hack: we know header is written separately from body, hence 4 writes if split
            assert.equal(written.length, 4)
            assert.equal(written[0][3], 99) // our seq id
            assert.equal(written[1].length, 0xffffff)
            assert.equal(written[1][0], 111)
            assert.equal(written[2][3], 100) // next seq id
            assert.equal(nextSeqId, 101)
            assert.equal(written[3].length, 100)
            assert.equal(written[3][0], 222)
            done()
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
