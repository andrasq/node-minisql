// npm install qtimeit minisql [mysql mysql2 mariadb]

'use strict';

if (!/benchmark/.test(require('path').basename(process.argv[1]))) return

var timeit = require('qtimeit');

var minisql, mysql, mysql2, mariadb;
var dbMinisql, dbMysql, dbMysql2, dbMariadb;

try { mysql = require('mysql') } catch (e) {}
try { mysql2 = require('mysql2') } catch (e) {}
try { mariadb = require('mariadb') } catch (e) {}     // mariadb crashes under node-v15
minisql = require('../');

var creds = { user: process.env.USER, password: process.env.DBPASSWORD, database: 'test', port: 3306 };

console.log("AR: Starting.");
var str200k = 'str200k-' + (new Array(2e5 + 1 - 8).join('x'));
var sql;
runSteps([
    function(next) {
        if (!minisql) return next();
        console.log("minisql %s", require('../package.json').version);
        dbMinisql = new minisql.Db().connect(creds, next);
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
        // var sql = 'SELECT 1';
        var sql = 'SELECT 1, "two", 3.5';
        runQuery(sql, next);
    },
    function(next) {
        var sql = 'SELECT COUNT(*) FROM information_schema.collations';
        runQuery(sql, next);
    },
    function(next) {
        var sql = 'SELECT * FROM information_schema.collations LIMIT 100';
        runQuery(sql, next);
    },
    function(next) {
        var sql = "SELECT '" + str200k + "'";
        runQuery(sql, next);
    },
    function(next) {
        dbMysql && dbMysql.end();
        dbMysql2 && dbMysql2.end();
        dbMariadb && dbMariadb.end();
        dbMinisql && dbMinisql.end(function(err){ console.log("AR: minisql end", err) });
        next();
    },
],
function(err) {
    console.log("AR: Done.", err);
});


function runQuery(sql, callback) {
    console.log("-------- %s", sql.length > 80 ? sql.slice(0, 80) + '...' : sql);
    var loopCount = 2;
    timeit.bench.verbose = 1;
    timeit.bench.visualize = true;
    timeit.bench.bargraphScale = 10;
    timeit.bench.timeGoal = .45;
    var bench = {};
    if (mysql) bench['mysql'] = function(cb) { dbMysql.query(sql, cb) };
    if (minisql) bench['minisql'] = function(cb) { dbMinisql.query(sql, cb) };
    if (minisql && dbMinisql.select) bench['minisql_select'] = function(cb) { dbMinisql.select(sql, cb) };
    if (mysql2) bench['mysql2'] = function(cb) { dbMysql2.query(sql, cb) };
    if (mariadb) bench['mariadb'] = function(cb) { dbMariadb.query(sql).then(cb) };
    if (minisql) bench['minisql_2'] = function(cb) { dbMinisql.query(sql, cb) };

    repeatFor(loopCount, function(done) { timeit.bench(bench, done) }, callback);
}

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

function getNames(items, field) {
    var names = new Array();
    for (var i=0; i<items.length; i++) names.push(items[i][field]);
    return names;
}
function buildHash(names, values) {
    var hash = {};
    for (var i=0; i<values.length; i++) hash[names[i]] = values[i];
    return hash;
}
