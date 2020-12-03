/*
 * useful utilities copied here from sources as indicated
 *
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

// var setImmediate = global.setImmediate || function(fn, a, b) { process.nextTick(function() { fn(a, b) }) }

module.exports = {
    // from `qibl`
    allocBuf: eval('parseInt(process.versions.node) > 9 ? Buffer.allocUnsafe : Buffer'),
    fromBuf: eval('parseInt(process.versions.node) > 9 ? Buffer.from : Buffer'),

    Bytes: Bytes,
    makeError: makeError,
    extractTo: extractTo,
    pairTo: pairTo,
    repeatFor: repeatFor,
    runSteps: runSteps,
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

        putUint1: function(v) { buf[pos++] = v & 0xFF },
        putUint2: function(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF },
        // putUint3: function(v) { putUint2(v); buf[pos++] = (v >>> 16) & 0xFF },
        putUint4: function(v) { bytes.putUint2(v); bytes.putUint2(v >>> 16) },
        putString: function(str) { pos = writeString(buf, pos, str) },
        putStringZ: function(str) { bytes.putString(str); buf[pos++] = 0 },
        putBinary: function(src) { for (var i=0; i<src.length; i++) buf[pos++] = src[i] },
        fillN: function(v, n) { for (var i=0; i<n; i++) buf[pos++] = v },

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
        skipV: function() { var len = bytes.getLenenc(); pos += len },

        // copyIn: function(src, base, bound) { while (base < bound) buf[pos++] = src[base++] },
        // copyOut: function(dst, to, n) { for (var i=0; i<n; i++) dst[to+i] = buf[pos++] },

        decodeBytesTo: function(dst, format, names) {
            for (var i = 0, j = 0; i < format.length; i++, j++) {
                var name = names[j]
                switch (format[i]) {
                case '1': dst[name] = bytes.getUint1(); break
                case '2': dst[name] = bytes.getUint2(); break
                case '3': dst[name] = bytes.getUint3(); break
                case '4': dst[name] = bytes.getUint4(); break
                case 'v': dst[name] = bytes.getLenenc(); break
                case 'z': dst[name] = bytes.getStringZ(); break
                case 'e': dst[name] = bytes.getStringN(bytes.databuf().length - bytes.tell()); break
                case 'S': dst[name] = bytes.getStringV(); break // lenenc string
                case 'N': dst[name] = bytes.getNumberV(); break // lenenc number
                case 'B': dst[name] = bytes.getBinaryV(); break // lenenc binary
                case 'X': bytes.skipV(); --j; break             // skip lenenc entity, do not gather
                case '=': bytes.skipN(2); --j; break
                //case '-': bytes.skipN(1); --j; break
                }
            }
            return dst
        }
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

var hrtime = process.hrtime || function() { var t = Date.now(); return [t/1000, 0] }
function microtime() { var ms = hrtime(); return ms[0] * 1000 + ms[1] / 1e6 }

function toStruct( hash ) { return toStruct.prototype = hash }