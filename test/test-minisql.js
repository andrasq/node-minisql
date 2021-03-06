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
var utils = require('../lib/utils')
var my = require('../lib/mysql')

var setImmediate = utils.setImmediate

// from `qibl`
var allocBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.alloc : Buffer')
var fromBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.from : Buffer')
var noop = function(){}

var mockCreds = { host: 'localhost', port: 3306, database: 'test', user: 'user', password: 'password' }

describe('minisql', function() {
    var db, packman, chunker, socket, connectStub
    beforeEach(function(done) {
        var noop = function(){}
        var mockSocket = { write: noop, once: noop, end: noop }
        // FIXME: is testing the Session, not the Db (that manages sessions)
        db = minisql.createConnection(mockCreds)._getRawDb()._getConnection()
        packman = db.packman
        packman._socket = mockSocket
        chunker = packman.chunker
        socket = new events.EventEmitter()
        socket.write = noop
        socket.setNoDelay = noop
        connectStub = qmock.stub(net, 'connect', function() {
            setImmediate(function() { socket.emit('connect') })
            return socket
        })
        done()
    })

    afterEach(function(done) {
        connectStub.restore()
        done()
    })

    describe('Db', function() {
        describe('constructor', function() {
            it('options are optional', function(done) {
                var db = minisql.createConnection()
                assert.ok(db)
                done()
            })
            it('has expected db methods', function(done) {
                var db = minisql.createConnection()
                assert.equal(typeof db.connect, 'function')
                assert.equal(typeof db.getConnection, 'function')
                assert.equal(typeof db.query, 'function')
                assert.equal(typeof db.runQueries, 'function')
                assert.equal(typeof db.end, 'function')
                done()
            })
            it('returns a connection', function(done) {
                var db = minisql.createConnection(
                    { user: 'mock', setup: ['select 1'], teardown: ['select 2'], connections: 2 })
                var conn = db.getConnection()
                assert.ok(conn)
                assert.ok(conn.id >= 1)
                assert.equal(conn.getConnection(), conn)
                done()
            })
            it.skip('runs setup and teardown commands', function(done) {
                var db = minisql.createConnection(
                    { user: 'mock', setup: ['select 1'], teardown: ['select 2'], connections: 2 })
                var conn = db.getConnection()
                var spy = qmock.spy(conn, 'query')
                db.connect(function(err) {
                    assert.ifError(err)
                    assert.equal(spy.callCount, 1)
                    assert.deepEqual(spy.args[0][0], 'select 1')
                    db.end(function() {
                        assert.equal(spy.callCount, 2)
                        assert.deepEqual(spy.args[1][0], 'select 2')
                        done()
                    })
                })
            })
        })
    })

    describe('Packeteer', function() {
        it('tallies total length', function(done) {
            chunker.write(fromBuf("abc"))
            assert.equal(chunker.nbytes, 3)
            chunker.write(fromBuf("defghi"))
            assert.equal(chunker.nbytes, 9)
            done()
        })
        it('grows first packet to 4', function(done) {
            chunker.write(fromBuf([1, 0]))
            chunker.write(fromBuf([]))
            chunker.write(fromBuf([0]))
            assert.equal(chunker.bufs.length, 3)
            // collapses chunks as soon as 4 bytes reached, pushes normally from then on
            chunker.write(fromBuf([4, 5]))
            assert.equal(chunker.bufs.length, 1)
            chunker.write(fromBuf([6, 7]))
            assert.equal(chunker.bufs.length, 2)
            assert.deepEqual(chunker.bufs[0], fromBuf([1, 0, 0, 4, 5]))
            assert.deepEqual(chunker.bufs[1], fromBuf([6, 7]))
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
                assert.deepEqual(packet, myPacket)
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
            var packet = utils.fromBuf([1, 0, 0, 1, 0]) // OK packet
            packman.packeter.write(packet)
            packman.error = new Error('mock error')
            packman.getPacket(function(err, packet) {
                assert.deepEqual(packet, packet)
                packman.getPacket(function(err, packet) {
                    assert.equal(packet[4], 0xff)
                    done()
                })
            })
        })
        it('getPacket does not gather data after connection error', function(done) {
            var packet = utils.fromBuf([1, 0, 0, 1, 0]) // OK packet
            packman.error = new Error('mock error')
            packman._socket.emit('data', packet)
            assert.equal(packman.chunker.bufs.length, 0)
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

    describe('Session', function() {
        describe('connect', function() {
            it('rejects protocol other than v10', function(done) {
                var packet = allocBuf(60); fill(packet, 0); packet[3] = 0; packet[4] = 99
                qmock.stubOnce(db.packman, 'getPacket').yields(null, packet)
                db._connect(mockCreds, function(err) {
                    assert.ok(err)
                    assert.ok(/bad.*protocol.*99/.test(err.message))
                    done()
                })
            })
            it('rejects other than the initial 0 sequence id', function(done) {
                var packet = allocBuf(60); fill(packet, 0); packet[3] = 2; packet[4] = 10
                qmock.stubOnce(db.packman, 'getPacket').yields(null, packet)
                db._connect(mockCreds, function(err) {
                    assert.ok(err)
                    assert.ok(/sequence id 2/.test(err.message))
                    done()
                })
            })
            it('rejects a non-OK response to handshake', function(done) {
                qmock.stub(db.packman, 'getPacket')
                  .onCall(0).yields(null, fromBuf([
                    1, 0, 0, 0, 10, 0, 4, 4, 4, 4, 48, 48, 48, 48, 48, 48, 48, 48, 0, 255, 255, 33, 2, 2,
                    0xff, 0xff, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 0, 109, 121, 0]))
                  .onCall(1).yields(null, fromBuf([1, 0, 0, 2, 255]))
                db._connect(mockCreds, function(err) {
                    assert.ok(err)
                    assert.ok(/not OK/.test(err.message))
                    done()
                })
            })
        })

        describe('_getPacketsEof', function() {
            it('returns received packets until, but not including, Eof', function(done) {
                qmock.stub(db.packman, 'getPacket')
                  .onCall(0).yields(null, fromBuf([1, 0, 0, 1, 7]))
                  .onCall(1).yields(null, fromBuf([1, 0, 0, 2, 8]))
                  .onCall(2).yields(null, fromBuf([1, 0, 0, 3, my.myHeaders.EOF])) // error packet
                db._getPacketsEof(null, 1, function(err, packets, seqId) {
                    assert.ifError(err)
                    assert.equal(seqId, 4)
                    assert.equal(packets.length, 2)
                    assert.deepEqual(packets[0], fromBuf([1, 0, 0, 1, 7]))
                    assert.deepEqual(packets[1], fromBuf([1, 0, 0, 2, 8]))
                    done()
                })
            })
            it('returns received packets until OK', function(done) {
                qmock.stub(db.packman, 'getPacket')
                  .onCall(0).yields(null, fromBuf([1, 0, 0, 1, 7]))
                  .onCall(1).yields(null, fromBuf([1, 0, 0, 2, 8]))
                  .onCall(2).yields(null, fromBuf([1, 0, 0, 3, my.myHeaders.OK])) // ok packet
                db._getPacketsEof(null, 1, function(err, packets, seqId) {
                    assert.ifError(err)
                    assert.equal(seqId, 4)
                    assert.equal(packets.length, 2)
                    assert.deepEqual(packets[0], fromBuf([1, 0, 0, 1, 7]))
                    assert.deepEqual(packets[1], fromBuf([1, 0, 0, 2, 8]))
                    done()
                })
            })
            it('returns error on invalid sequence id', function(done) {
                qmock.stub(db.packman, 'getPacket')
                  .onCall(0).yields(null, fromBuf([1, 0, 0, 3, 7]))
                  .onCall(1).yields(null, fromBuf([1, 0, 0, 2, my.myHeaders.OK]))
                db._getPacketsEof(null, 3, function(err, packets) {
                    assert.ok(err)
                    assert.ok(err instanceof Error)
                    assert.ok(/bad sequence id 2.*expected.*4/.test(err.message))
                    done()
                })
            })
            it('returns Error packet as err', function(done) {
                var errPacket = [9, 0, 0, 3, 255, 0, 4, 35, 48, 48, 48, 48, 48, 69, 69, 69]
                qmock.stub(db.packman, 'getPacket')
                  .onCall(0).yields(null, fromBuf([1, 0, 0, 1, 7]))
                  .onCall(1).yields(null, fromBuf([1, 0, 0, 2, 8]))
                  .onCall(2).yields(null, errPacket)
                db._getPacketsEof(null, 1, function(err, packets, seqId) {
                    assert.ok(err)
                    assert.deepEqual(packets, [fromBuf([1, 0, 0, 1, 7]), fromBuf([1, 0, 0, 2, 8])])
                    assert.equal(err, errPacket)
                    assert.equal(seqId, 4) // next sequence number in this chain
                    done()
                })
            })
        })

        describe('query', function() {
            it('requires query', function(done) {
                assert.throws(function() { db.query(noop) }, /query.*required/)
                done()
            })
            it('requires callback', function(done) {
                assert.throws(function() { db.query('select 1') }, /callback.*required/)
                done()
            })
            it('converts query to a Query packet', function(done) {
                var spy = qmock.stub(db.packman, 'sendPacket', function(packet) { packet[3] = 0; return 1 })
                qmock.stub(db, '_readResult')
                db.query('SELECT 12321', noop)
                assert.ok(spy.called)
                assert.deepEqual(spy.args[0][0][3], 0)  // sequence id
                assert.deepEqual(spy.args[0][0][4], 3)  // COM_QUERY
                assert.deepEqual(spy.args[0][0].slice(5), fromBuf('SELECT 12321'))
                done()
            })
            it.skip('splits a long query into multiple packets', function(done) {
                // WRITEME
            })
            it('calls _readResult', function(done) {
                qmock.stub(db.packman, 'sendPacket')
                var spy = qmock.stub(db, '_readResult')
                db.query('SELECT 1', noop)
                assert.ok(spy.called)
                done()
            })
            it('interpolates aruments into query', function(done) {
                packman.sendPacket = function() { return 1 }    // fast stub
                db._readResult = function(query, seqId, startMs, callback) { queryString = query }
                var queryString, now = new Date('2020-01-02 03:04:56 UTC');
                db.query('SELECT ?, ?, ?, ?, ? FROM _test WHERE id IN (?)', [1, false, null, now, /Foo/i, [2.5, "foo", ["bar"]]], done)
                assert.equal(queryString, "SELECT 1, 0, NULL, '2020-01-02T03:04:56.000Z', '/Foo/i' FROM _test WHERE id IN (2.5, 'foo', 'bar')")
                done()
            })
            it('escapes special chars in interpolated arguments', function(done) {
                packman.sendPacket = function() { return 1 }    // fast stub
                db._readResult = function(query, seqId, startMs, callback) { queryString = query }
                var queryString;

                // ', ", \, \0 are all escaped as \', \", \\, \\\0
                db.query('SELECT ?, ?, ?', ["foo'bar\\'", 'foo"bar\x00"', ["'", '\\']], done)
                assert.equal(queryString, "SELECT 'foo\\'bar\\\\\\'', 'foo\\\"bar\\\u0000\\\"', '\\\'', '\\\\'")

                done()
            })
            it('interpolates arguments and composes query fast', function(done) {
                packman.sendPacket = function() { return 1 }    // fast stub
                var queryString;
                db._readResult = function(query, seqId, startMs, callback) { queryString = query; callback() }

                var args = [1, 2, ['two', 3]]
                var ix = 0, queries = [
                    'select ?, ?, ? from _mock',
                    'select * from _mock where a = ? and b = ? and c in (?)',
                ]
                console.time('time to send 100k 4-arg queries')
                utils.repeatFor(100000, function(next, ix) { db.query(queries[ix & 1], args, next) }, function() {
                    console.timeEnd('time to send 100k 4-arg queries')
                    // 160ms if interpolating 4, 60ms if no args, ie 1ms per 1k queries
                    done()
                })
                // 100k queries prepared in 160ms (60ms if no args) lowers the 100k/s db rate to 90k/s
                // NOTE: could be lowered to 90ms by using template-specific interpolation functions
            })
            it('queues readers in order if connection is busy', function(done) {
                var conn = db // this file initializes db to a Session
                conn.isReading = true
                var cb = function() {}
                assert.equal(conn.readWaitlist.size() , 0) // empty before
                conn.query('select something', cb)
                conn.query('select something else', cb)
                assert.equal(conn.readWaitlist.size(), 2)  // not empty after
                assert.deepEqual(conn.readWaitlist.peekAt(0)[0], 'select something')
                assert.deepEqual(conn.readWaitlist.peekAt(0)[3], cb)
                assert.deepEqual(conn.readWaitlist.peekAt(1)[0], 'select something else')
                assert.deepEqual(conn.readWaitlist.peekAt(1)[3], cb)
                done()
            })
        })

        describe('_readResult', function() {
            it('decodes rows fast', function(done) {
                var rowbuf = utils.fromBuf([12, 0, 0, 1, 1, 0x31, 3, 0x32, 0x2e, 0x35, 5, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
                var decoders = [my.bbytes.getNumberV, my.bbytes.getNumberV, my.bbytes.getStringV]
                console.time('decode 100k rows')
                for (var i = 0; i < 100000; i++) {
                    var row = my.decodeRowValues(3, rowbuf, decoders)
                    // var hash = utils.pairTo({}, ['a', 'b', 'c'], row)
                }
                console.timeEnd('decode 100k rows')
                done()
                // array: 10k in 8ms, 100k in 28ms, 1m in 204ms; hash: 10k in 12ms, 100k in 35ms, 1m in 270ms
            })
            describe('errors', function() {
                it('errors out on unexpected EOF packet', function(done) {
                    // server should never send an EOF response, only OK, ERROR, INFILE or data
                    qmock.stub(db.packman, 'getPacket').yields(null, utils.fromBuf([0, 0, 0, 1, my.myHeaders.EOF]))
                    db._readResult('query', 1, 1234, function(err, rows) {
                        assert.ok(err)
                        assert.ok(err.message.match(/unexpected EOF/))
                        done()
                    })
                })
                it('does not implement LOCAL INFILE', function(done) {
                    qmock.stub(db.packman, 'getPacket').yields(null, utils.fromBuf([0, 0, 0, 1, my.myHeaders.LOCAL, 0x4a]))
                    db._readResult('query', 1, 1234, function(err, rows) {
                        assert.ok(err)
                        assert.ok(err.message.match(/not handled/))
                        done()
                    })
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
            it('returns query errors', function(done) {
                var spy = qmock.stub(db, 'query').yields(new Error('mock error'))
                db._select('select 1', function(err, rows) {
                    assert.ok(err)
                    assert.ok(spy.called)
                    assert.equal(err.message, 'mock error')
                    done()
                })
            })
        })
    })
})

function fill(a, v) {
    for (var i=0; i<a.length; i++) a[i] = v
}
