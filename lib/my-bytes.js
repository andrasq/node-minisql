'use strit';

var utf8 = require('q-utf8');

module.exports = Bytes;

function Bytes(buf) {
    buf = buf || [];
    var pos = 0;

    var bytes = {
        open: function(_buf, _pos) { buf = _buf; pos = _pos || 0 },
        seek: function(_pos) { pos = _pos },
        tell: function() { return pos },
        databuf: function() { return buf },

        readUint3: function(buf, pos) { return buf[pos++] + (buf[pos++] << 8) + (buf[pos] << 16) },
        writeUint3: function(buf, v, pos) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF; buf[pos] = (v >>> 16) & 0xFF },

        putUint1: function(v) { buf[pos++] = v & 0xFF },
        putUint2: function(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF },
        putUint3: function(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF; buf[pos++] = (v >>> 16) & 0xFF },
        putUint4: function(v) { bytes.putUint2(v); bytes.putUint2(v >>> 16) },
        putString: function(str) { pos = utf8.utf8_encode(str, 0, str.length, buf, pos) },
        putStringZ: function(str) { pos = utf8.utf8_encode(str, 0, str.length, buf, pos); buf[pos++] = 0 },
        putBinary: function(src) { for (var i=0; i<src.length; i++) buf[pos++] = src[i] },
        fillN: function(v, n) { for (var i=0; i<n; i++) buf[pos++] = v },

        getUint1: function() { return buf[pos++] },
        getUint2: function() { return buf[pos++] + (buf[pos++] << 8) },
        getUint3: function() { return buf[pos++] + (buf[pos++] << 8) + (buf[pos++] << 16) },
        getUint4: function() { return bytes.getUint2() + bytes.getUint2() * 0x10000 },
        getStringN: function(n) { return utf8.utf8_decode(buf, pos, pos += n) },
        getStringZ: function() { var base = pos; while (buf[pos]) pos++; return utf8.utf8_decode(buf, base, pos++) },
        getBinaryN: function(n) { return buf.slice(pos, pos += n) },
        getStringLenenc: function() { var len = bytes.getLenenc(); return len === null ? null : bytes.getStringN(len) },
        skipN: function(n) { pos += n },
        getLenenc: function() { var v1 = buf[pos++]; return (v1 <= 250) ? v1
            : (v1 === 251) ? null : (v1 === 252) ? bytes.getUint2()
            : (v1 === 253) ? bytes.getUint3() : (v1 === 254) ? bytes.getUint4() + bytes.getUint4() * 0x100000000 : NaN },

        copyIn: function(src, base, bound) { while (base < bound) buf[pos++] = src[base++] },
        copyOut: function(dst, to, n) { for (var i=0; i<n; i++) dst[to+i] = buf[pos++] },
    }
    return bytes;
}
