/*
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

// npm install qtimeit mysqule [mysql mysql2 mariadb]

'use strict';

if (!/benchmark/.test(require('path').basename(process.argv[1]))) return

// monitor event loop blockage
var lastRan = Date.now();
var totalBlocked = 0;
var lagPoller = setInterval(
    function() { var now = Date.now(); totalBlocked += (now - lastRan) - 5; lastRan = now }, 5);
var lagReporter = setInterval(
    function() { if (totalBlocked > 10) console.log("event loop blocked %d ms", totalBlocked); totalBlocked = 0 }, 1000);
if (lagPoller.unref) lagPoller.unref();
if (lagReporter.unref) lagReporter.unref();

var timeit = require('qtimeit');
var utils = require('../lib/utils');

var mysqule, mysql, mysql2, mariadb;
var dbMysqule, dbMysqulePar, dbMysql, dbMysql2, dbMariadb;

try { mysql = require('mysql') } catch (e) {}
try { mysql2 = require('mysql2') } catch (e) {}
try { mariadb = require('mariadb') } catch (e) {}     // mariadb 2.0.3 crashes under node-v15
mysqule = require('../');

var creds = { user: process.env.USER, password: process.env.DBPASSWORD, database: 'test', port: 3306 };

console.log("AR: Starting.");
var str200k = 'str200k-' + (new Array(2e5 + 1 - 8).join('x'));
var sql;
var parallelCount = 10;
var connectionCount = 2;
var loopCount = 3;
timeit.bench.timeGoal = .45;
utils.runSteps([
    function(next) {
        if (!mysqule) return next();
        console.log("mysqule %s", require('../package.json').version);
        dbMysqule = mysqule.createConnection(creds).connect(next);
    },
    function(next) {
        if (!mysqule) return next();
        console.log("mysqule %s", require('../package.json').version);
        dbMysqulePar = mysqule.createConnection(utils.extractTo({ connections: connectionCount }, creds, creds)).connect(next);
    },
    function(next) {
        if (!mysql) return next();
        console.log("mysql %s", require('mysql/package.json').version);
        dbMysql = mysql.createConnection(creds);
        dbMysql.connect(next);
    },
    function(next) {
        if (!mysql2) return next();
        // reading the version errors out with "package not exported" under node-v13 and up
        try { console.log("mysql2 %s", require('mysql2/package.json').version) } catch(e) {}
        dbMysql2 = mysql2.createConnection(creds);
        dbMysql2.connect(next);
    },
    function(next) {
        if (!mariadb) return next();
        try { console.log("mariadb %s", require('mariadb/package.json').version) } catch(e) {}
        mariadb.createConnection(creds).then(function(db) {
            (dbMariadb = db).connect().then(function(db2) {
                next();
            })
        })
    },
    function(next) {
        dbMysqule.runQueries([
            'create database if not exists test',
            'use test',
            'create table if not exists _collations_copy like information_schema.collations',
            'delete from _collations_copy',
            'insert into _collations_copy select * from information_schema.collations',
        ], function(err, info) {
            console.log("AR: copied collations in %d ms", info.duration_ms)
            next()
        })
    },
    function(next) {
        // var sql = 'SELECT 1';
        var sql = 'SELECT 1, "series", 3.5';
        runQuery(sql, null, next);
    },
    /**
    function(next) {
        // var sql = 'SELECT 1';
        var sql = 'SELECT ?, ?, ?';
        runQuery(sql, [1, "series", 3.5], next);
    },
    **/
    function(next) {
        // var sql = 'SELECT 1';
        var sql = 'SELECT 1, "pipelined", 3.5';
        runQueryPipelined(sql, parallelCount, null, next);
    },
    function(next) {
        var sql = 'SELECT COUNT(*), "pipelined", 3.5 FROM _collations_copy';
        runQueryPipelined(sql, parallelCount, null, next);
    },

    /**
    function(next) {
        var sql = 'SELECT COUNT(*) FROM information_schema.collations';
        runQuery(sql, null, next);
    },
    function(next) {
        var sql = 'SELECT * FROM information_schema.collations LIMIT 100';
        runQuery(sql, null, next);
    },
    function(next) {
        var sql = "SELECT '" + str200k + "'";
        runQuery(sql, null, next);
    },
    **/
    function(next) {
        dbMysql && dbMysql.end();
        dbMysql2 && dbMysql2.end();
        dbMariadb && dbMariadb.end();
        dbMysqule && dbMysqule.end(function(err){ console.log("AR: mysqule end", err) });
        dbMysqulePar && dbMysqulePar.end(function(err){ console.log("AR: mysqulePar end", err) });
        next();
    },
],
function(err) {
    console.log("AR: Done.", err);
});


function runQuery( sql, params, callback ) { runQueryPipelined(sql, 1, params, callback ) }
function runQueryPipelined(sql, count, params, callback) {
    console.log("\n-------- %s", sql.length > 80 ? sql.slice(0, 80) + '...' : sql);
    timeit.bench.verbose = 1;
    timeit.bench.visualize = true;
    timeit.bench.bargraphScale = 10;
    timeit.bench.opsPerTest = (count <= 1) ? 1 : count;
    timeit.bench.showTestInfo = true;
    var bench = {};
    if (count <= 1) {
        if (mysql) bench['mysql'] = function(cb) { dbMysql.query(sql, cb) };
        if (mysql) bench['mysql_2'] = function(cb) { dbMysql.query(sql, params, cb) };
        if (mysql2) bench['mysql2'] = function(cb) { dbMysql2.query(sql, cb) };
        if (mysql2) bench['mysql2_2'] = function(cb) { dbMysql2.query(sql, params, cb) };
        if (sql.indexOf('?') < 0) {
        if (mariadb) bench['mariadb'] = function(cb) { dbMariadb.query(sql).then(cb) };
        if (mariadb) bench['mariadb_2'] = function(cb) { dbMariadb.query(sql).then(cb) };
        }
        if (mysqule) bench['mysqule'] = function(cb) { dbMysqule.query(sql, cb) };
        if (mysqule) bench['mysqule_2'] = function(cb) { dbMysqule.query(sql, params, cb) };
        if (mysqule) bench['mysqulePar'] = function(cb) { dbMysqulePar.query(sql, cb) };
        if (mysqule) bench['mysqulePar_2'] = function(cb) { dbMysqulePar.query(sql, params, cb) };
        // if (mysqule && dbMysqule._select) bench['mysqule_select'] = function(cb) { dbMysqule._select(sql, cb) };
    } else {
        var runemPromise = function(db, method, query, cb) {
            var ndone = 0;
            for (var i=0; i<count; i++) { db[method](query).then(onDone) }
            function onDone(err, rows) { ndone += 1; if (ndone >= count) cb() }
        }
        var runem = function(db, method, query, cb) {
            var ndone = 0;
            for (var i=0; i<count; i++) { db[method](query, onDone) }
            function onDone(err, rows) { ndone += 1; if (ndone >= count) cb() }
        }
        if (mysql) bench['mysql'] = function(cb) { runem(dbMysql, 'query', sql, cb) };
        if (mysql) bench['mysql_2'] = function(cb) { runem(dbMysql, 'query', sql, cb) };
        if (mysql2) bench['mysql2'] = function(cb) { runem(dbMysql2, 'query', sql, cb) };
        if (mysql2) bench['mysql2_2'] = function(cb) { runem(dbMysql2, 'query', sql, cb) };
        if (sql.indexOf('?') < 0) {
        if (mariadb) bench['mariadb'] = function(cb) { runemPromise(dbMariadb, 'query', sql, cb) };
        if (mariadb) bench['mariadb_2'] = function(cb) { runemPromise(dbMariadb, 'query', sql, cb) };
        }
        if (mysqule) bench['mysqule'] = function(cb) { runem(dbMysqule, 'query', sql, cb) };
        if (mysqule) bench['mysqule_2'] = function(cb) { runem(dbMysqule, 'query', sql, cb) };
        if (mysqule) bench['mysqulePar'] = function(cb) { runem(dbMysqulePar, 'query', sql, cb) };
        if (mysqule) bench['mysqulePar_2'] = function(cb) { runem(dbMysqulePar, 'query', sql, cb) };
        // if (mysqule && dbMysqule._select) bench['mysqule_select'] = function(cb) { runem(dbMysqule, '_select', sql, cb) };
    }
    utils.repeatFor(loopCount, function(done) { timeit.bench(bench, done) }, callback);
}
