/*
 * useful utilities copied here from sources as indicated
 *
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

var setImmediate = eval('global.setImmediate || function(fn, a, b) { process.nextTick(function() { fn(a, b) }) }')

// from `qibl`
var allocBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.allocUnsafe : Buffer')
var fromBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.from : Buffer')

module.exports = {
    setImmediate: setImmediate,
    allocBuf: allocBuf,
    fromBuf: fromBuf,

    Bytes: Bytes,
    makeError: makeError,
    extractTo: extractTo,
    assignTo: assignTo,
    pairTo: pairTo,
    repeatFor: repeatFor,
    runSteps: runSteps,
    // Mutex: Mutex,
    microtime: microtime, // misnamed, is millitime
    toStruct: toStruct,
}

var util = require('util')
var utf8 = require('q-utf8')

/*
 * Raw byte i/o
 * Functions for reading and writing buffers or arrays of charcodes.
 */
function Bytes(buf) {
    buf = buf || [];
    var pos = 0;

    var bytes = {
        open: function(_buf, _pos) { buf = _buf; pos = _pos || 0; return bytes },
        tell: function() { return pos },
        databuf: function() { return buf },
        seek: function(_pos) { pos = _pos },

        readUint3: function(buf, pos) { return buf[pos++] + (buf[pos++] << 8) + (buf[pos] << 16) },
        writeUint3: function(buf, pos, v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF; buf[pos] = (v >>> 16) & 0xFF },
        /** for testing:
        readLenenc: function(buf, pos) { var v1 = buf[pos++]; return (v1 <= 250) ? v1
            : (v1 === 251) ? null
            : (v1 === 252) ? (buf[pos++] * buf[pos] * 256)
            : (v1 === 253) ? (buf[pos++] + buf[pos++] * 256 + buf[pos++] * 256*256)
            : (v1 === 254) ? 0xffffffffffffffff : NaN },
        /**/
        putUint1: function(v) { buf[pos++] = v & 0xFF },
        putUint2: function(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF },
        putUint4: function(v) { bytes.putUint2(v); bytes.putUint2(v >>> 16) },
        putString: function(str) { pos = writeString(buf, pos, str) },
        putStringZ: function(str) { bytes.putString(str); buf[pos++] = 0 },
        putBinary: function(src) { for (var i=0; i<src.length; i++) buf[pos++] = src[i] },

        getUint1: function() { return buf[pos++] },
        getUint2: function() { return buf[pos++] + (buf[pos++] << 8) },
        getUint3: function() { return buf[pos++] + (buf[pos++] << 8) + (buf[pos++] << 16) },
        getUint4: function() { return bytes.getUint2() + bytes.getUint2() * 0x10000 },
        getStringN: function(n) { return readString(buf, pos, pos += n) },
        getStringZ: function() { var base = pos; while (buf[pos]) pos++; return readString(buf, base, pos++) },
        getBinaryN: function(n) { return buf.slice(pos, pos += n) },
        skipN: function(n) { pos += n },
        getLenenc: function() { var v1 = buf[pos++]; return (v1 <= 250) ? v1
            : (v1 === 251) ? null : (v1 === 252) ? bytes.getUint2()
            : (v1 === 253) ? bytes.getUint3() : (v1 === 254) ? bytes.getUint4() + bytes.getUint4() * 0x100000000 : NaN },
        // getNumberN: function(n) { return parseFloat(bytes.getStringN(n)) },
        // read lenenc variable length mysql data
        getNumberV: function() { var len = bytes.getLenenc(); return len === null ? null : parseFloat(bytes.getStringN(len)) },
        getStringV: function() { var len = bytes.getLenenc(); return len === null ? null : bytes.getStringN(len) },
        getBinaryV: function() { var len = bytes.getLenenc(); return len === null ? null : bytes.getBinaryN(len) },
        skipV: function() { var len = bytes.getLenenc(); pos += Number(len) },

        // copyIn: function(src, base, bound) { while (base < bound) buf[pos++] = src[base++] },
        // copyOut: function(dst, to, n) { for (var i=0; i<n; i++) dst[to+i] = buf[pos++] },

        decodeBytesTo: function(dst, format, names) {
            var values = new Array()
            for (var i = 0; i < format.length; i++) {
                switch (format[i]) {
                case ' ': break
                case '1': values.push(bytes.getUint1()); break
                case '2': values.push(bytes.getUint2()); break
                case '3': values.push(bytes.getUint3()); break
                case '4': values.push(bytes.getUint4()); break
                case '8': values.push(bytes.getBinaryN(8)); break;
                case 'v': values.push(bytes.getLenenc()); break
                case 'z': values.push(bytes.getStringZ()); break
                case 'e': values.push(bytes.getStringN(bytes.databuf().length - bytes.tell())); break
                case 'S': values.push(bytes.getStringV()); break // lenenc string
                case 'N': values.push(bytes.getNumberV()); break // lenenc number
                case 'B': values.push(bytes.getBinaryV()); break // lenenc binary
                case 'X': bytes.skipV(); break                   // skip lenenc entity, do not gather
                case '+': bytes.skipN(1); break
                // case '-': bytes.skipN(-1); break
                }
            }
            if (names.length > values.length)  names = names.slice(0, values.length)
            return pairTo(dst, names, values)
        },
    }
    return bytes;

    // function isAscii(str) { return !/[^\x01-0x7f]/.test(str) }
    function writeString(buf, pos, str) {
        // it is faster to utf8-encode than to isAscii/copyloop
        return (Buffer.isBuffer(buf)) ? buf.write(str, pos) : utf8.utf8_encode(str, 0, str.length, buf, pos)
    }
    function readString(buf, fm, to) {
        // return (to - fm > 20 && Buffer.isBuffer(buf)) ? buf.toString('utf8', fm, to) : utf8.utf8_decode(buf, fm, to)
        return (to - fm <= 40 || !Buffer.isBuffer(buf)) ? utf8.utf8_decode(buf, fm, to) : buf.toString('utf8', fm, to)
    }
}

// ----------------------------------------------------------------

function makeError( props, fmt ) {
    var args = [].slice.call(arguments);
    var err = new Error(util.format.apply(null, typeof args[0] === 'object' ? args.slice(1) : args))
    if (typeof args[0] === 'object') extractTo(err, args[0], args[0])
    return err
}

// see the miniq assignTo
function extractTo(dst, src, mask) {
    for (var k in mask) dst[k] = src[k]
    return dst
}
function assignTo(dst, src) {
    for (var k in src) dst[k] = src[k]
    return dst
}

// set the named property on dst to the matching value, ignore extra values
function pairTo(dst, names, values) {
    for (var i=0; i<names.length; i++) dst[names[i]] = values[i]
    return dst
}

function repeatFor(n, proc, callback) {
    var ix = 0, ncalls = 0;
    (function _loop(err) {
        if (err || n-- <= 0) return callback(err);
        (ncalls++ > 100) ? process.nextTick((++n, (ncalls = 0), _loop)) : proc(_loop, (ix++));
    })()
}

// iterateSteps adapted from miniq, originally from qrepeat and aflow
function runSteps(steps, callback) {
    var ix = 0;
    (function _loop(err, a1, a2) {
        if (err || ix >= steps.length) return callback(err, a1, a2);
        steps[ix++](_loop, a1, a2);
    })()
}

/** // mutex from miniq
function Mutex(limit) {
    this.busy = 0;
    this.limit = limit || 1;
    this.queue = new Array();   // new QList()

    var self = this;
    this.acquire = function acquire(user) {
        if (self.busy < self.limit) { self.busy += 1; user(self.release) }
        else self.queue.push(user);
    }
    this.release = function release() {
        var next = self.queue.shift();
        (next) ? setImmediate(next, self.release) : self.busy -= 1;
    }
} **/

var hrtime = process.hrtime || function() { var t = Date.now(); return [t/1000, 0] }
function microtime() { var ms = hrtime(); return ms[0] * 1000 + ms[1] * 1e-6 }

function toStruct( hash ) { return toStruct.prototype = hash }
