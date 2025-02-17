import * as b4a from "b4a";

const ZEROS = "0000000000000000000";
const SEVENS = "7777777777777777777";
const ZERO_OFFSET = "0".charCodeAt(0);
const USTAR_MAGIC = b4a.from("ustar\x00", "utf8");
const USTAR_VER = b4a.from("00", "utf8");
const GNU_MAGIC = b4a.from("ustar\x20", "utf8");
const GNU_VER = b4a.from("\x20\x00", "utf8");
const MASK = 0o7777;
const MAGIC_OFFSET = 257;
const VERSION_OFFSET = 263;

function clamp<T>(input: unknown, len: number, defaultValue: T) {
  if (typeof input !== "number") return defaultValue;
  let index = ~~input; // Coerce to integer.
  if (index >= len) return len;
  if (index >= 0) return index;
  index += len;
  if (index >= 0) return index;
  return 0;
}

const toType = function (flag: number) {
  switch (flag) {
    case 0:
      return "file";
    case 1:
      return "link";
    case 2:
      return "symlink";
    case 3:
      return "character-device";
    case 4:
      return "block-device";
    case 5:
      return "directory";
    case 6:
      return "fifo";
    case 7:
      return "contiguous-file";
    case 72:
      return "pax-header";
    case 55:
      return "pax-global-header";
    case 27:
      return "gnu-long-link-path";
    case 28:
    case 30:
      return "gnu-long-path";
  }

  return null;
};

const toTypeflag = function (flag: string | undefined) {
  switch (flag) {
    case "file":
      return 0;
    case "link":
      return 1;
    case "symlink":
      return 2;
    case "character-device":
      return 3;
    case "block-device":
      return 4;
    case "directory":
      return 5;
    case "fifo":
      return 6;
    case "contiguous-file":
      return 7;
    case "pax-header":
      return 72;
  }

  return 0;
};

function indexOf<T>(block: ArrayLike<T>, num: T, offset: number, end: number) {
  for (; offset < end; offset++) {
    if (block[offset] === num) return offset;
  }
  return end;
}

const cksum = function (block: ArrayLike<number>) {
  let sum = 8 * 32;
  for (let i = 0; i < 148; i++) sum += block[i];
  for (let j = 156; j < 512; j++) sum += block[j];
  return sum;
};

const encodeOct = function (valNum: number, n: number) {
  const val = valNum.toString(8);
  if (val.length > n) return SEVENS.slice(0, n) + " ";
  else return ZEROS.slice(0, n - val.length) + val + " ";
};

/* Copied from the node-tar repo and modified to meet
 * tar-stream coding standard.
 *
 * Source: https://github.com/npm/node-tar/blob/51b6627a1f357d2eb433e7378e5f05e83b7aa6cd/lib/header.js#L349
 */
function parse256(buf: Buffer | Uint8Array) {
  // first byte MUST be either 80 or FF
  // 80 for positive, FF for 2's comp
  let positive;
  if (buf[0] === 0x80) positive = true;
  else if (buf[0] === 0xff) positive = false;
  else return null;

  // build up a base-256 tuple from the least sig to the highest
  const tuple = [];
  let i;
  for (i = buf.length - 1; i > 0; i--) {
    const byte = buf[i];
    if (positive) tuple.push(byte);
    else tuple.push(0xff - byte);
  }

  let sum = 0;
  const l = tuple.length;
  for (i = 0; i < l; i++) {
    sum += tuple[i] * Math.pow(256, i);
  }

  return positive ? sum : -1 * sum;
}

const decodeOct = function (
  val: Buffer | Uint8Array,
  offset: number,
  length: number
) {
  val = val.slice(offset, offset + length);
  offset = 0;

  // If prefixed with 0x80 then parse as a base-256 integer
  if (val[offset] & 0x80) {
    return parse256(val);
  } else {
    // Older versions of tar can prefix with spaces
    while (offset < val.length && val[offset] === 32) offset++;
    const end = clamp(
      indexOf(val, 32, offset, val.length),
      val.length,
      val.length
    );
    while (offset < end && val[offset] === 0) offset++;
    if (end === offset) return 0;
    return parseInt(val.slice(offset, end).toString(), 8);
  }
};

const decodeStr = function (
  val: Buffer | Uint8Array,
  offset: number,
  length: number,
  encoding?: BufferEncoding
) {
  return val
    .slice(offset, indexOf(val, 0, offset, offset + length))
    .toString(encoding);
};

const addLength = function (str: string) {
  const len = b4a.byteLength(str);
  let digits = Math.floor(Math.log(len) / Math.log(10)) + 1;
  if (len + digits >= Math.pow(10, digits)) digits++;

  return len + digits + str;
};

export function decodeLongPath(
  buf: Buffer | Uint8Array,
  encoding?: BufferEncoding
) {
  return decodeStr(buf, 0, buf.length, encoding);
}

interface EncodePaxOpts {
  name?: string;
  linkname?: string;
  pax?: { [key: string]: string };
}

export const encodePax = function (opts: EncodePaxOpts) {
  // TODO: encode more stuff in pax
  let result = "";
  if (opts.name) result += addLength(" path=" + opts.name + "\n");
  if (opts.linkname) result += addLength(" linkpath=" + opts.linkname + "\n");
  const pax = opts.pax;
  if (pax) {
    for (const key in pax) {
      result += addLength(" " + key + "=" + pax[key] + "\n");
    }
  }
  return b4a.from(result);
};

export const decodePax = function (buf: Buffer | Uint8Array) {
  const result: { [key: string]: string } = {};

  while (buf.length) {
    let i = 0;
    while (i < buf.length && buf[i] !== 32) i++;
    const len = parseInt(buf.slice(0, i).toString(), 10);
    if (!len) return result;

    const b = buf.slice(i + 1, len - 1).toString();
    const keyIndex = b.indexOf("=");
    if (keyIndex === -1) return result;
    result[b.slice(0, keyIndex)] = b.slice(keyIndex + 1);

    buf = buf.slice(len);
  }

  return result;
};

interface EncodeOpts {
  name: string;
  typeflag?: number;
  linkname?: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: Date;
  type?: string;
  uname?: string;
  gname?: string;
  devmajor?: number;
  devminor?: number;
}

export const encode = function (opts: EncodeOpts) {
  const buf = b4a.alloc(512);
  let name = opts.name;
  let prefix = "";

  if (opts.typeflag === 5 && name[name.length - 1] !== "/") name += "/";
  if (b4a.byteLength(name) !== name.length) return null; // utf-8

  while (b4a.byteLength(name) > 100) {
    const i = name.indexOf("/");
    if (i === -1) return null;
    prefix += prefix ? "/" + name.slice(0, i) : name.slice(0, i);
    name = name.slice(i + 1);
  }

  if (b4a.byteLength(name) > 100 || b4a.byteLength(prefix) > 155) return null;
  if (opts.linkname && b4a.byteLength(opts.linkname) > 100) return null;

  b4a.write(buf, name);
  b4a.write(buf, encodeOct(opts.mode & MASK, 6), 100);
  b4a.write(buf, encodeOct(opts.uid, 6), 108);
  b4a.write(buf, encodeOct(opts.gid, 6), 116);
  b4a.write(buf, encodeOct(opts.size, 11), 124);
  b4a.write(buf, encodeOct((opts.mtime.getTime() / 1000) | 0, 11), 136);

  buf[156] = ZERO_OFFSET + toTypeflag(opts.type);

  if (opts.linkname) b4a.write(buf, opts.linkname, 157);

  b4a.copy(USTAR_MAGIC, buf, MAGIC_OFFSET);
  b4a.copy(USTAR_VER, buf, VERSION_OFFSET);
  if (opts.uname) b4a.write(buf, opts.uname, 265);
  if (opts.gname) b4a.write(buf, opts.gname, 297);
  b4a.write(buf, encodeOct(opts.devmajor || 0, 6), 329);
  b4a.write(buf, encodeOct(opts.devminor || 0, 6), 337);

  if (prefix) b4a.write(buf, prefix, 345);

  b4a.write(buf, encodeOct(cksum(buf), 6), 148);

  return buf;
};

export interface DecodedHeader {
  mode: null | number;
  devmajor: null | number;
  uid: null | number;
  gid: null | number;
  size: number;
  uname: string;
  name: string;
  devminor: null | number;
  mtime: Date;
  type: string | null;
  linkname: null | string;
  gname: string;
}

export function decode(
  buf: Buffer | Uint8Array,
  filenameEncoding?: BufferEncoding,
  allowUnknownFormat?: boolean
): DecodedHeader | null {
  let typeflag = buf[156] === 0 ? 0 : buf[156] - ZERO_OFFSET;

  let name = decodeStr(buf, 0, 100, filenameEncoding);
  const mode = decodeOct(buf, 100, 8);
  const uid = decodeOct(buf, 108, 8);
  const gid = decodeOct(buf, 116, 8);
  // TODO: This should just error out
  const size = decodeOct(buf, 124, 12) ?? 0;
  const mtime = decodeOct(buf, 136, 12);
  const type = toType(typeflag);
  const linkname =
    buf[157] === 0 ? null : decodeStr(buf, 157, 100, filenameEncoding);
  const uname = decodeStr(buf, 265, 32);
  const gname = decodeStr(buf, 297, 32);
  const devmajor = decodeOct(buf, 329, 8);
  const devminor = decodeOct(buf, 337, 8);

  const c = cksum(buf);

  // checksum is still initial value if header was null.
  if (c === 8 * 32) return null;

  // valid checksum
  if (c !== decodeOct(buf, 148, 8))
    throw new Error(
      "Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?"
    );

  if (
    b4a.compare(USTAR_MAGIC, buf.subarray(MAGIC_OFFSET, MAGIC_OFFSET + 6)) === 0
  ) {
    // ustar (posix) format.
    // prepend prefix, if present.
    if (buf[345])
      name = decodeStr(buf, 345, 155, filenameEncoding) + "/" + name;
  } else if (
    b4a.compare(GNU_MAGIC, buf.subarray(MAGIC_OFFSET, MAGIC_OFFSET + 6)) === 0 &&
    b4a.compare(GNU_VER, buf.subarray(VERSION_OFFSET, VERSION_OFFSET + 2)) === 0
  ) {
    // 'gnu'/'oldgnu' format. Similar to ustar, but has support for incremental and
    // multi-volume tarballs.
  } else {
    if (!allowUnknownFormat) {
      throw new Error("Invalid tar header: unknown format.");
    }
  }

  // to support old tar versions that use trailing / to indicate dirs
  if (typeflag === 0 && name && name[name.length - 1] === "/") typeflag = 5;

  return {
    name,
    mode,
    uid,
    gid,
    size,
    mtime: mtime === null ? new Date() : new Date(1000 * mtime),
    type,
    linkname,
    uname,
    gname,
    devmajor,
    devminor,
  };
}
