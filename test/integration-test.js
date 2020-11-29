/*
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

var assert = require('assert')
var minisql = require('../')
var Db = minisql.Db

var creds = { host: 'localhost', port: 3306, database: 'test',
              user: process.env.MYSQL_USER || process.env.USER, password: process.env.MYSQL_PASSWORD }

var setImmediate = global.setImmediate || process.nextTick
var fromBuf = Buffer.from ? Buffer.from : Buffer

function runSteps(steps, callback) {
    var ix = 0;
    (function _loop(err, a1, a2) {
        if (err || ix >= steps.length) return callback(err, a1, a2);
        steps[ix++](_loop, a1, a2);
    })()
}

function repeatFor(n, proc, callback) {
    (function _loop(err) {
        if (err || n-- <= 0) return callback(err);
        proc(_loop);
    })()
}

describe('integration tests', function() {
    var db;

    beforeEach(function(done) {
        db = minisql.createConnection({ user: creds.user, password: creds.password })
        runSteps([
            function(next) { db.connect(next) },
            function(next) { db.query('set global max_allowed_packet = 1000000000;', next) },
            function(next) { db.query('create database if not exists test;', next) },
            function(next) { db.query('use test;', next) },
        ], done)
    })

    afterEach(function(done) {
        db.end(function(err) { done() })
    })

    describe('connect', function() {
        it('requires username', function(done) {
            assert.throws(function() { new Db().connect({}, function(){}) }, /user required/)
            done()
        })
        it('requires callback',function(done) {
            assert.throws(function() { new Db().connect({user: 'test'}) }, /callback required/)
            done()
        })
        it('connects and talks to the database', function(done) {
            var now = Date.now()
            var db = new Db()
            db.connect(creds, function(err) {
                assert.ifError(err)
                db.query('SELECT 1, 2.5', function(err, rows) {
                    assert.equal(rows.length, 1)
                    assert.deepEqual(rows[0], [1, 2.5])
                    done()
                })
            })
        })
        it('connects to a named database', function(done) {
            var localCreds = { user: creds.user, password: creds.password, database: 'information_schema' }
            db.connect(localCreds, function(err) {
                assert.ifError(err)
                db.query('SHOW TABLES', function(err, rows) {
                    assert.ifError(err)
                    assert.ok(rows.length > 10)
                    done()
                })
            })
        })
        it('connects without a database', function(done) {
            var localCreds = { user: creds.user, password: creds.password }
            db.connect(localCreds, function(err) {
                assert.ifError(err)
                db.query('SHOW TABLES', function(err, rows) {
                    assert.ok(err)
                    assert.ok(/No database/.test(err.message))
                    done()
                })
            })
        })
        it('connects with createConnection', function(done) {
            var localCreds = { user: creds.user, password: creds.password, database: 'test' }
            minisql.createConnection(localCreds).connect(function(err) {
                assert.ifError()
                db.query('SELECT 1', function(err, rows) {
                    assert.ifError(err)
                    assert.deepEqual(rows, [ [1] ])
                    done()
                })
            })
        })
    })

    describe('ping', function() {
        it('gets response from db', function(done) {
            db.ping(function(err, res) {
                assert.ifError(err)
                assert.ok(res)
                done()
            })
        })
    })

    describe('execute', function() {
        it('can execute commands', function(done) {
            db.query('USE test', function(err) {
                assert.ifError(err)
                done()
            })
        })
        it('returns status', function(done) {
            db.query('USE test', function(err, ok) {
                assert.ok(ok)
                assert.strictEqual(ok.affectedRows, 0)
                assert.strictEqual(ok.lastInsertId, 0)
                done()
            })
        })
        it('returns sql errors', function(done) {
            db.query('INSRET INTO', function(err, ok) {
                assert.ok(err)
                assert.ok(err.message.indexOf('SQL syntax') > 0)
                assert.equal(typeof err.errorMessage, 'string')
                assert.equal(typeof err.errorCode, 'number')
                done()
            })
        })
        it('returns connection errors', function(done) {
            db.end(function() {
                db.query('SELECT 1', function(err, res) {
                    assert.ok(err)
                    assert.ok(/connection closed/.test(err.message))
                    done()
                })
            })
        })
    })
    describe('query', function() {
        function sendBytes(db, str, cb) {
            db.query('SELECT "' + str + '"', function(err, rows) {
                assert.ifError(err)
                assert.equal(rows[0][0], str)
                cb()
            })
        }

        it('returns errors', function(done) {
            db.query('SLECT FROM', function(err, ok) {
                assert.ok(err)
                assert.ok(err.message.indexOf('SQL syntax') > 0)
                assert.equal(typeof err.errorMessage, 'string')
                assert.equal(typeof err.errorCode, 'number')
                done()
            })
        })
        it('returns a response', function(done) {
            var value = Math.random() * 0x1000000 >>> 0
            db.query('SELECT "' + value + '"', function(err, rows) {
                assert.ifError(err)
                assert.ok(Array.isArray(rows))
                assert.equal(rows.length, 1)
                assert.equal(rows[0].length, 1)
                assert.equal(rows[0][0], value)
                done()
            })
        })
        it('returns an empty response', function(done) {
            db.query('SELECT * from information_schema.collations WHERE id = "nonesuch"', function(err, ret) {
                assert.ifError(err)
                assert.equal(ret.length, 0)
                done()
            })
        })
        it('returns duplicate columns', function(done) {
            db.query('SELECT 1 AS a, 2 AS a, 3 AS a', function(err, rows) {
                assert.ifError(err)
                assert.equal(rows[0].length, 3)
                done()
            })
        })
        it('returns column info', function(done) {
            db.query('SELECT * FROM information_schema.collations WHERE id = 8', function(err, rows) {
                assert.ifError(err)
                var info = db.queryInfo()
                // assert.deepEqual(info.columns[2], { col: 2, name: 'ID', type: 8, table: 'collations' })
                assert.ok(Array.isArray(info.columnNames))
                assert.ok(info.columnNames.indexOf('ID') >= 0)
                assert.ok(info.columnNames.indexOf('CHARACTER_SET_NAME') >= 0)
                done()
            })
        })
        it('returns numbers', function(done) {
            db.query('SELECT 1 AS hay, 2.5 AS bee, POW(2, 3) as cee', function(err, rows) {
                assert.ifError(err)
                assert.deepEqual(rows[0], [1, 2.5, 8])
                done()
            })
        })
        it('responds to LOCAL INFILE requests', function(done) {
            // not enabled currently
            return done()

            db.query('CREATE TEMPORARY TABLE _junk (x INT)', function(err) {
                assert.ifError(err)
                db.query('LOAD DATA LOCAL INFILE "/dev/null" INTO TABLE _junk', function(err, packet) {
                    assert.ok(err && packet)
                    assert.ok(/not handled/, err.message)
                    assert.equal(packet.filename, '/dev/null')
                    done()
                })
            })
        })
        it('returns timestamps as strings', function(done) {
            var t1 = Date.now(); t1 = new Date(t1 - t1 % 1000)
            db.query('SELECT "hello" AS txt, NOW() AS dt', function(err, rows) {
                var t2 = Date.now(); t2 = new Date(t2 - t2 % 1000)
                assert.ifError(err)
                assert.strictEqual(rows[0][0], 'hello')
                assert.equal(typeof rows[0][1], 'string')
                var dt = new Date(rows[0][1])
                assert.ok(dt >= t1 && dt <= t2)
                done()
            })
        })
        it('returns numbers, strings, floats, binary, with column info', function(done) {
            runSteps([
                function(next) {
                    db.query('CREATE TEMPORARY TABLE _junk (x INT, a CHAR(20), f FLOAT, b BLOB)', next)
                },
                function(next) {
                    db.query('INSERT INTO _junk VALUES (1, "aa", 1.5, UNHEX("313233")), (2, "bb", 2.5, null), (3, "cc", 3.5, null)', next)
                },
                function(next) {
                    db.query('SELECT * FROM _junk WHERE x % 2 = 1', next)
                },
                function(next, rows) {
                    var info = db.queryInfo()
                    assert.equal(rows.length, 2)
                    assert.deepEqual(info.columnNames, ['x', 'a', 'f', 'b'])
                    assert.strictEqual(rows[0][0], 1)
                    assert.strictEqual(rows[0][1], 'aa')
                    assert.strictEqual(rows[0][2], 1.5)
                    assert.ok(Buffer.isBuffer(rows[0][3]))
                    assert.equal(rows[0][3].toString(), "123")
                    next()
                },
            ], done)
        })
        it('returns metadata', function(done) {
            db.query('SHOW DATABASES', function(err, rows) {
                assert.ifError(err)
                assert.ok(rows.length >= 2)
                assert.equal(typeof rows[0][0], 'string')
                done()
            })
        })
        it('interpolates arguments into the query', function(done) {
            var args = [1, 'two', fromBuf([0x41, 0x42, 0x43]), [3.5, 'four']]
            db.query('SELECT ?, ?, ?, ?', args, function(err, rows) {
                assert.ifError(err)
                // the buffer is received as a binary string but is returned as a string
                assert.deepEqual(rows[0], [1, 'two', 'ABC', 3.5, 'four'])
                done();
            })
        })
        it('can send 2^16-1 bytes', function(done) {
            // 'SELECT ""' is 9 bytes, account for them
            sendBytes(db, new Array((1 << 24) - 1 + 1 - 9).join('x'), done)
        })
        it('can send 2^16+0 bytes', function(done) {
            sendBytes(db, new Array((1 << 24) + 0 + 1 - 9).join('x'), done)
        })
        it('can send 2^16+1 bytes', function(done) {
            sendBytes(db, new Array((1 << 24) + 1 + 1 - 9).join('x'), done)
        })
        it('can send and receive large commands spanning 2 packets', function(done) {
            var str1k = new Array(1001).join('x').slice()
            var str20m = new Array(17001).join(str1k).slice()
            var sql = 'SELECT "' + str20m + '" AS bulk';        // 10 bytes for the SELECT query + 17m
            var t1 = Date.now()
            db.query(sql, function(err, rows) {
                var t2 = Date.now()
                var info = db.queryInfo()
                console.log("AR: 17m in %d (%d ms)", t2 - t1, info && info.duration_ms, info);
                assert.ifError(err)
                assert.equal(rows.length, 1)
                assert.equal(rows[0][0], str20m)
// console.log("AR: mem", process.memoryUsage())
// 200mb string payload uses 1gb rss, 600mb heap, 432mb external.  250mb crashes.
                done()
            })
        })
        it('can send and receive commands spanning 3 packets', function(done) {
            var str1k = new Array(1001).join('x').slice()
            var str40m = new Array(35001).join(str1k).slice()
            var sql = 'SELECT "' + str40m + '"';
            db.query(sql, function(err, rows) {
                var info = db.queryInfo()
                console.log("AR: 34m in %d ms", info && info.duration_ms);
                assert.ifError(err)
                assert.equal(rows.length, 1)
                assert.equal(rows[0][0], str40m)
                done()
            })
        })
        describe('speed', function() {
            it('is quick', function(done) {
                var steps = new Array(2000)
                for (var i=0; i<steps.length; i++) steps[i] = _call
                var t1 = Date.now()
                runSteps(steps, function(err) {
                    var t2 = Date.now()
                    console.log("AR: ran %d calls (%d ms)", steps.length, t2 - t1)
                    // 83ms for 2k calls, 395ms for 20k
                    done(err)
                })
                function _call(cb) {
                    db.query('SELECT 1', cb)
                }
            })
        })
    })
    describe('select', function() {
        it('returns hashes', function(done) {
            db._select('SELECT 1 AS a, "two" as be, 3.5 as cee', function(err, rows) {
                assert.ifError(err)
                assert.deepEqual(rows[0], { a: 1, be: 'two', cee: 3.5 })
                done()
            })
        })
    })

    describe('datatypes', function() {
    })
})
