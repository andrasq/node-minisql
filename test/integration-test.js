/*
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

// run by hand, not part of the test-* suite

var assert = require('assert')
var Db = require('../').Db

var creds = { host: 'localhost', port: 3306, database: 'test',
              user: process.env.DBUSER || process.env.USER, password: process.env.DBPASSWORD }

var setImmediate = global.setImmediate || process.nextTick

function runSteps(steps, callback) {
    var ix = 0
    function _loop(err, r1, r2) {
        if (err || ix >= steps.length) return callback(err, r1, r2)
        steps[ix++](_loop, r1, r2)
    }
    _loop()
}

function repeatFor(n, proc, callback) {
    function _loop(err) {
        if (err) return callback(err);
        (n-- > 0) ? proc(_loop) : callback()
    }
    _loop();
}

describe('integration tests', function() {
    var db;

    beforeEach(function(done) {
        db = new Db()
        db.connect(creds, function(err) {
            if (err) return done(err)
            // TODO: allow for an auto-run configScript to init the system vars
            db.query('set global max_allowed_packet = 1000000000;', done)
        })
    })

    afterEach(function(done) {
        db.end(done)
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
        it('returns errors', function(done) {
            db.query('INSRET INTO', function(err, ok) {
                assert.ok(err)
                assert.ok(err.message.indexOf('SQL syntax') > 0)
                assert.equal(typeof err.errorMessage, 'string')
                assert.equal(typeof err.errorCode, 'number')
                done()
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
        it('returns numbers', function(done) {
            db.query('SELECT 1 AS hay, 2.5 AS bee, POW(2, 3) as cee', function(err, rows) {
                assert.ifError(err)
                assert.deepEqual(rows[0], [1, 2.5, 8])
                done()
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
                function(next, rows, info) {
                    assert.equal(rows.length, 2)
                    assert.deepEqual(info.columns.map((c) => c.name), ['x', 'a', 'f', 'b'])
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
            sql = 'SELECT "' + str20m + '" AS bulk';            // 10 bytes for the SELECT query + 17m
            var t1 = Date.now()
            db.query(sql, function(err, rows, info) {
                var t2 = Date.now()
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
            sql = 'SELECT "' + str40m + '"';
            db.query(sql, function(err, rows, info) {
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

    describe('datatypes', function() {
    })
})
