import * as bl from "bl";
import {Writable, PassThrough, WritableEvents} from "streamx";
import * as headers from "./headers";

const noop = function () {};

const overflow = function (sizeInput: number | null | undefined) {
  const size = Number(sizeInput) & 511;
  return size && 512 - size;
};

const emptyStream = function (self: Writable, offset: number) {
  const s = new Source(self, offset);
  s.end();
  return s;
};

interface Pax {
  path?: string;
  linkpath?: string;
  size?: string;
}

type PaxMixin = { name?: string; linkname?: string; size?: number; pax: Pax };
function mixinPax<T extends object>(header: headers.DecodedHeader, pax: Pax): headers.DecodedHeader & PaxMixin {
  const newHeader: headers.DecodedHeader & PaxMixin = header as any;
  if (pax.path) newHeader.name = pax.path;
  if (pax.linkpath) newHeader.linkname = pax.linkpath;
  if (pax.size) newHeader.size = parseInt(pax.size, 10);
  newHeader.pax = pax;
  return newHeader;
}

class Source extends PassThrough {
  _parent: Writable;
  offset: number;
  constructor(self: Writable, offset: number) {
    super();
    this._parent = self;
    this.offset = offset;
  }

  _predestroy() {
    this._parent.destroy();
  }
}

interface ExtractOpts extends ConstructorParameters<typeof Writable> {
  filenameEncoding?: BufferEncoding;
  allowUnknownFormat?: boolean;
}

interface ExtractEvents extends WritableEvents<any> {
  entry: (header: headers.DecodedHeader, source: Source, cb: (err?: Error) => void) => void;
}

class Extract extends Writable<any, any, any, false, true, ExtractEvents> {
  _offset = 0;
  _buffer = bl();
  _missing = 0;
  _partial = false;
  _onparse = noop;
  _header: headers.DecodedHeader | (headers.DecodedHeader & PaxMixin) | null = null;
  _stream: Source | null = null;
  _overflow: Buffer | Uint8Array | null = null;
  _cb: (() => void) | null = null;
  _locked = false;
  _pax: {[key: string]: string} | null = null;
  _paxGlobal: {[key: string]: string} | null = null;
  _gnuLongPath: string | null = null;
  _gnuLongLinkPath: string | null = null;
  _onheader: (() => void) | null = null;
  constructor(paramOpts?: ExtractOpts) {
    super(paramOpts);

    let opts = paramOpts || ({} as Record<string, undefined>);

    const self = this;
    const b = self._buffer;

    const oncontinue = function () {
      self._continue();
    };

    const onunlock = function (err?: Error) {
      self._locked = false;
      if (err) return self.destroy(err);
      if (!self._stream) oncontinue();
    };

    const onstreamend = function () {
      self._stream = null;
      const drain = overflow(self._header?.size);
      if (drain) self._parse(drain, ondrain);
      else self._parse(512, onheader);
      if (!self._locked) oncontinue();
    };

    const ondrain = function () {
      self._buffer.consume(overflow(self._header?.size));
      self._parse(512, onheader);
      oncontinue();
    };

    const onpaxglobalheader = function () {
      const size = self._header?.size ?? 0;
      self._paxGlobal = headers.decodePax(b.slice(0, size));
      b.consume(size);
      onstreamend();
    };

    const onpaxheader = function () {
      const size = self._header?.size ?? 0;
      self._pax = headers.decodePax(b.slice(0, size));
      if (self._paxGlobal)
        self._pax = Object.assign({}, self._paxGlobal, self._pax);
      b.consume(size);
      onstreamend();
    };

    const ongnulongpath = function () {
      const size = self._header?.size ?? 0;
      self._gnuLongPath = headers.decodeLongPath(
        b.slice(0, size),
        opts.filenameEncoding
      );
      b.consume(size);
      onstreamend();
    };

    const ongnulonglinkpath = function () {
      const size = self._header?.size ?? 0;
      self._gnuLongLinkPath = headers.decodeLongPath(
        b.slice(0, size),
        opts.filenameEncoding
      );
      b.consume(size);
      onstreamend();
    };

    const onheader = function () {
      const offset = self._offset;
      let header;
      try {
        header = self._header = headers.decode(
          b.slice(0, 512),
          opts.filenameEncoding,
          opts.allowUnknownFormat
        );
      } catch (err) {
        self.destroy(err as Error);
      }
      b.consume(512);

      if (!header) {
        self._parse(512, onheader);
        oncontinue();
        return;
      }

      if (header.type === "gnu-long-path") {
        self._parse(header.size, ongnulongpath);
        oncontinue();
        return;
      }

      if (header.type === "gnu-long-link-path") {
        self._parse(header.size, ongnulonglinkpath);
        oncontinue();
        return;
      }

      if (header.type === "pax-global-header") {
        self._parse(header.size, onpaxglobalheader);
        oncontinue();
        return;
      }

      if (header.type === "pax-header") {
        self._parse(header.size, onpaxheader);
        oncontinue();
        return;
      }

      if (self._gnuLongPath) {
        header.name = self._gnuLongPath;
        self._gnuLongPath = null;
      }

      if (self._gnuLongLinkPath) {
        header.linkname = self._gnuLongLinkPath;
        self._gnuLongLinkPath = null;
      }

      if (self._pax) {
        self._header = header = mixinPax(header, self._pax);
        self._pax = null;
      }

      self._locked = true;

      if (!header.size || header.type === "directory") {
        self._parse(512, onheader);
        self.emit("entry", header, emptyStream(self, offset), onunlock);
        return;
      }

      self._stream = new Source(self, offset);

      self.emit("entry", header, self._stream, onunlock);
      self._parse(header.size, onstreamend);
      oncontinue();
    };

    this._onheader = onheader;
    this._parse(512, onheader);
  }

  _parse(size: number, onparse: () => void): void {
    this._offset += size;
    this._missing = size;
    if (onparse === this._onheader) this._partial = false;
    this._onparse = onparse;
  }

  _continue() {
    const cb = this._cb;
    this._cb = noop;
    if (this._overflow) this._write(this._overflow, cb ?? noop);
    else cb?.();
  }

  _write(data: Buffer | Uint8Array, cb: () => unknown) {
    const s = this._stream;
    const b = this._buffer;
    const missing = this._missing;
    if (data.byteLength) this._partial = true;

    // we do not reach end-of-chunk now. just forward it
    if (data.byteLength < missing) {
      this._missing -= data.byteLength;
      this._overflow = null;
      if (s) {
        if (s.write(data)) cb();
        else s.once("drain", cb);
        return;
      }
      b.append(data);
      return cb();
    }

    // end-of-chunk. the parser should call cb.
    this._cb = cb;
    this._missing = 0;

    let overflow = null;
    if (data.byteLength > missing) {
      overflow = data.subarray(missing);
      data = data.subarray(0, missing);
    }

    if (s) s.end(data);
    else b.append(data);

    this._overflow = overflow;
    this._onparse();
  }

  _final(cb: (err: Error | null) => unknown) {
    cb(this._partial ? new Error("Unexpected end of data") : null);
  }
}

export function extract(opts?: ExtractOpts) {
  return new Extract(opts);
}
