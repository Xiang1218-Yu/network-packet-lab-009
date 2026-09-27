import express, { type Request, type Response } from 'express';
import type {
  HeaderInspection,
  HexRow,
  InspectionDiagnostic,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  QueryParamInspection,
  RequestInspection,
  SimulatedPacket,
  TimelineEvent
} from '../shared/types.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  response.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

const HTTP_SAMPLES: Record<PacketScenario, string> = {
  request: 'GET /api/devices?status=online HTTP/1.1\r\nHost: lab.local\r\nAccept: application/json\r\nUser-Agent: PacketLab/1.0\r\nX-Trace-Id: 7f3a9c\r\n\r\n',
  response: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 47\r\nCache-Control: no-store\r\n\r\n{"devices":[{"id":"edge-01","status":"online"}]}',
  handshake: 'GET / HTTP/1.1\r\nHost: lab.local\r\nConnection: keep-alive\r\n\r\n'
};

const TCP_SAMPLES: Record<PacketScenario, string> = {
  request: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=18492031 Ack=77120102 | Flags=ACK,PSH | Win=64240 | Len=128',
  response: 'TCP 10.0.0.8:443 > 10.0.0.24:51842 | Seq=77120102 Ack=18492159 | Flags=ACK,PSH | Win=28960 | Len=512',
  handshake: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=0 Ack=0 | Flags=SYN | Win=64240 | MSS=1460 | WS=7'
};

function hexDump(value: string): HexRow[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  const rows: HexRow[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    rows.push({
      offset: index.toString(16).padStart(4, '0'),
      bytes: slice.map((byte) => byte.toString(16).padStart(2, '0')),
      ascii: slice.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('')
    });
  }
  return rows;
}

function field(id: string, key: string, value: string, description: string, children?: ProtocolField[]): ProtocolField {
  return { id, key, value, description, ...(children ? { children } : {}) };
}

/** Split a request target into path and non-empty `&` query segments (offsets are relative to the target). */
function splitQueryTarget(target: string): {
  path: string;
  query: string | null;
  segments: { segment: string; offset: number }[];
} {
  const qIndex = target.indexOf('?');
  const path = qIndex > -1 ? target.slice(0, qIndex) : target;
  const query = qIndex > -1 ? target.slice(qIndex + 1) : null;
  const segments: { segment: string; offset: number }[] = [];
  if (query !== null) {
    let cursor = qIndex + 1;
    for (const segment of query.split('&')) {
      const offset = cursor;
      cursor += segment.length + 1;
      if (segment) segments.push({ segment, offset });
    }
  }
  return { path, query, segments };
}

/** Target child nodes shared by the field tree and the inspector fieldId links. */
function targetFieldChildren(target: string): ProtocolField[] {
  const { path, query, segments } = splitQueryTarget(target);
  const children = [
    field('http-target-path', 'Path', path || '/', 'Request path, raw undecoded text')
  ];
  if (query !== null) {
    children.push(
      field(
        'http-target-query',
        'Query',
        query || '(empty)',
        'Raw query string, undecoded',
        segments.map(({ segment }, index) => {
          const separator = segment.indexOf('=');
          const key = separator > -1 ? segment.slice(0, separator) : segment;
          const value = separator > -1 ? segment.slice(separator + 1) : null;
          return field(
            `http-query-${index}`,
            key || `param-${index + 1}`,
            value === null ? '(no value)' : value || '(empty)',
            'Query parameter, raw segment'
          );
        })
      )
    );
  }
  return children;
}

function parseHttpFields(raw: string): ProtocolField[] {
  const [head, body = ''] = raw.split(/\r?\n\r?\n/);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? '';
  const headers = lines.map((line, index) => {
    const separator = line.indexOf(':');
    const key = separator > -1 ? line.slice(0, separator).trim() : `Header-${index + 1}`;
    const value = separator > -1 ? line.slice(separator + 1).trim() : line.trim();
    return field(`header-${index}`, key, value || '(empty)', 'HTTP header field');
  });
  const isResponse = startLine.startsWith('HTTP/');
  const [first, second, third] = startLine.split(' ');
  return [
    field('http-start-line', isResponse ? 'Status-Line' : 'Request-Line', startLine, isResponse ? 'HTTP version and response status' : 'HTTP method, target and version', [
      field('http-part-1', isResponse ? 'Version' : 'Method', first ?? '—', isResponse ? 'Protocol version' : 'HTTP request method'),
      field('http-part-2', isResponse ? 'Status' : 'Target', second ?? '—', isResponse ? 'Status code' : 'Request target', isResponse ? undefined : targetFieldChildren(second ?? '')),
      field('http-part-3', isResponse ? 'Reason' : 'Version', isResponse ? (third ?? '—') : (third ?? '—'), isResponse ? 'Reason phrase' : 'Protocol version')
    ]),
    field('http-headers', 'Headers', `${headers.length} fields`, 'Metadata carried by the application layer', headers),
    field('http-body', 'Payload', body || '(empty)', 'Application payload after the header terminator')
  ];
}

const HEX_DIGIT = /^[0-9a-fA-F]$/;

/**
 * Percent-decode one component while preserving the original text.
 * Malformed `%` escapes are kept verbatim and reported with their absolute
 * offset inside the request target; `+` becomes a space inside the query.
 */
function decodeComponent(
  raw: string,
  baseOffset: number,
  plusAsSpace: boolean
): { decoded: string; diagnostics: InspectionDiagnostic[] } {
  const diagnostics: InspectionDiagnostic[] = [];
  let decoded = '';
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length) {
      decoded += Buffer.from(bytes).toString('utf8');
      bytes = [];
    }
  };
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '%') {
      const high = raw[index + 1];
      const low = raw[index + 2];
      if (high && low && HEX_DIGIT.test(high) && HEX_DIGIT.test(low)) {
        bytes.push(parseInt(high + low, 16));
        index += 2;
      } else {
        flushBytes();
        const offset = baseOffset + index;
        const found = raw.slice(index, index + 3);
        diagnostics.push({
          code: 'malformed-encoding',
          severity: 'error',
          offset,
          message: `请求目标位置 ${offset}：“%” 后应为两位十六进制字符（实际为 “${found}”），已按原文保留`,
          messageEn: `Target offset ${offset}: '%' must be followed by two hex digits (found '${found}'); kept as literal text`
        });
        decoded += char;
      }
    } else if (plusAsSpace && char === '+') {
      flushBytes();
      decoded += ' ';
    } else {
      flushBytes();
      decoded += char;
    }
  }
  flushBytes();
  return { decoded, diagnostics };
}

function notApplicable(reason: string, reasonEn: string): RequestInspection {
  return { applicable: false, reason, reasonEn };
}

/** Build the semantic request inspection: method, path, query params, headers and body. */
function inspectHttpRequest(raw: string): RequestInspection {
  const [head, body = ''] = raw.split(/\r?\n\r?\n/);
  const lines = head.split(/\r?\n/);
  const startLine = lines[0] ?? '';
  if (!startLine.trim() || startLine.startsWith('HTTP/')) {
    return notApplicable(
      '当前数据包是 HTTP 响应，没有请求方法、请求目标或查询参数可供检查。',
      'This packet is an HTTP response; request method, target and query are not present.'
    );
  }

  const [method = '', target = ''] = startLine.split(' ');
  const { path: rawPath, query, segments } = splitQueryTarget(target);
  const diagnostics: InspectionDiagnostic[] = [];

  const pathDecoded = decodeComponent(rawPath, 0, false);
  const pathDiagnostics = [...pathDecoded.diagnostics];
  if (pathDecoded.decoded !== rawPath) {
    pathDiagnostics.push({
      code: 'encoded',
      severity: 'info',
      message: '路径包含百分号编码，原始文本已保留。',
      messageEn: 'Path contains percent-encoding; the raw text is preserved.'
    });
  }
  diagnostics.push(...pathDiagnostics);

  const params: QueryParamInspection[] = segments.map(({ segment, offset }, index) => {
    const separator = segment.indexOf('=');
    const rawKey = separator > -1 ? segment.slice(0, separator) : segment;
    const rawValue = separator > -1 ? segment.slice(separator + 1) : null;
    const keyDecoded = decodeComponent(rawKey, offset, true);
    const valueDecoded = rawValue === null
      ? null
      : decodeComponent(rawValue, offset + separator + 1, true);
    const paramDiagnostics: InspectionDiagnostic[] = [
      ...keyDecoded.diagnostics,
      ...(valueDecoded?.diagnostics ?? [])
    ];
    if (keyDecoded.decoded !== rawKey || (valueDecoded && valueDecoded.decoded !== rawValue)) {
      paramDiagnostics.push({
        code: 'encoded',
        severity: 'info',
        message: '包含百分号编码或 “+”，解码前的原始文本已保留。',
        messageEn: 'Contains percent-encoding or “+”; the raw pre-decode text is preserved.'
      });
    }
    if (separator === -1) {
      paramDiagnostics.push({
        code: 'no-value',
        severity: 'warning',
        message: '该参数没有 “=”，属于无值参数。',
        messageEn: 'Parameter has no “=”, so it carries no value.'
      });
    } else if (rawValue === '') {
      paramDiagnostics.push({
        code: 'empty-value',
        severity: 'info',
        message: '“=” 之后没有内容，参数值为空字符串。',
        messageEn: 'Nothing follows “=”; the value is an empty string.'
      });
    }
    return {
      id: `query-param-${index}`,
      index,
      rawSegment: segment,
      rawKey,
      decodedKey: keyDecoded.decoded,
      rawValue,
      decodedValue: valueDecoded ? valueDecoded.decoded : null,
      diagnostics: paramDiagnostics,
      fieldId: `http-query-${index}`
    };
  });

  const keyCounts = new Map<string, number>();
  for (const param of params) {
    keyCounts.set(param.decodedKey, (keyCounts.get(param.decodedKey) ?? 0) + 1);
  }
  const duplicateKeys = [...keyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
  for (const param of params) {
    const count = keyCounts.get(param.decodedKey) ?? 0;
    if (count > 1) {
      param.diagnostics.push({
        code: 'duplicate-key',
        severity: 'warning',
        message: `键 “${param.decodedKey}” 在查询字符串中重复出现 ${count} 次。`,
        messageEn: `Key '${param.decodedKey}' appears ${count} times in the query string.`
      });
    }
    diagnostics.push(...param.diagnostics);
  }

  const headers: HeaderInspection[] = lines.slice(1).map((line, index) => {
    const separator = line.indexOf(':');
    const name = separator > -1 ? line.slice(0, separator).trim() : line.trim();
    const value = separator > -1 ? line.slice(separator + 1).trim() : '';
    return {
      id: `inspector-header-${index}`,
      index,
      name: name || `Header-${index + 1}`,
      value,
      fieldId: `header-${index}`
    };
  });

  return {
    applicable: true,
    method: { value: method || '—', fieldId: 'http-part-1' },
    target,
    path: {
      raw: rawPath,
      decoded: pathDecoded.decoded,
      diagnostics: pathDiagnostics,
      fieldId: 'http-target-path'
    },
    query: query === null
      ? null
      : { raw: query, fieldId: 'http-target-query', params },
    duplicateKeys,
    headers,
    body: { value: body, fieldId: 'http-body' },
    diagnostics
  };
}

function parseTcpFields(raw: string): ProtocolField[] {
  const [route = '', ...parts] = raw.split(' | ');
  const [protocol, source = '—', arrow = '>', destination = '—'] = route.split(' ');
  const values = new Map(parts.map((part) => {
    const separator = part.indexOf('=');
    return separator > -1 ? [part.slice(0, separator), part.slice(separator + 1)] : [part, 'true'];
  }));
  return [
    field('ethernet', 'Link Layer', 'Ethernet II', 'Frame envelope', [
      field('ethernet-src', 'Source MAC', '02:42:ac:11:00:24', 'Simulated interface address'),
      field('ethernet-dst', 'Destination MAC', '02:42:ac:11:00:08', 'Simulated gateway address'),
      field('ethernet-type', 'Type', '0x0800 · IPv4', 'Network protocol identifier')
    ]),
    field('ipv4', 'Internet Layer', 'IPv4', 'Logical addressing and delivery', [
      field('ipv4-source', 'Source', source, 'Origin IP and port'),
      field('ipv4-destination', 'Destination', destination, 'Target IP and port'),
      field('ipv4-protocol', 'Next Protocol', protocol || 'TCP', 'Transport protocol')
    ]),
    field('tcp', 'Transport Layer', 'TCP', 'Reliable stream transport', [
      field('tcp-seq', 'Sequence', values.get('Seq') ?? '—', 'Byte sequence position'),
      field('tcp-ack', 'Acknowledgement', values.get('Ack') ?? '—', 'Next expected byte'),
      field('tcp-flags', 'Flags', values.get('Flags') ?? '—', 'Control bits'),
      field('tcp-window', 'Window', values.get('Win') ?? '—', 'Receive window size'),
      field('tcp-length', 'Payload Length', values.get('Len') ?? '0', 'TCP segment data length')
    ]),
    field('tcp-payload', 'Payload', values.get('Len') === '0' ? '(empty)' : 'Encrypted application data', 'Data carried by the segment')
  ];
}

function timelineFor(protocol: Protocol, scenario: PacketScenario): TimelineEvent[] {
  const prefix = protocol === 'HTTP' ? 'HTTP' : 'TCP';
  const steps = protocol === 'HTTP'
    ? [
        ['ingress', 'Frame captured', 'NIC received an application frame'],
        ['parse', 'Headers indexed', 'Start line and header fields identified'],
        ['application', `${prefix} payload decoded`, scenario === 'response' ? 'Response body is ready for inspection' : 'Request target and metadata extracted'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ]
    : [
        ['ingress', 'Segment captured', 'Transport segment received from the simulated wire'],
        ['transport', 'TCP header decoded', 'Sequence, acknowledgement and flags extracted'],
        ['parse', 'Layer tree assembled', 'Ethernet → IPv4 → TCP hierarchy created'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ];
  return steps.map(([phase, label, detail], index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    timestamp: `00:00:0${index}.${(index * 37 + 12).toString().padStart(2, '0')}`,
    label,
    phase: phase as TimelineEvent['phase'],
    detail
  }));
}

function checksum(raw: string): string {
  let hash = 0;
  for (const byte of Buffer.from(raw, 'utf8')) hash = (hash + byte * 31) % 65535;
  return `0x${hash.toString(16).padStart(4, '0').toUpperCase()}`;
}

function buildPacket(protocol: Protocol, scenario: PacketScenario, raw: string): SimulatedPacket {
  const safeRaw = raw.trim() ? raw : (protocol === 'HTTP' ? HTTP_SAMPLES[scenario] : TCP_SAMPLES[scenario]);
  const isHttp = protocol === 'HTTP';
  const inspection: RequestInspection = isHttp
    ? inspectHttpRequest(safeRaw)
    : notApplicable(
        '当前数据包是 TCP 报文，没有 HTTP 请求方法、请求目标或查询参数。',
        'This packet is a TCP segment; HTTP request semantics do not apply.'
      );
  return {
    id: `${protocol.toLowerCase()}-${scenario}-${Date.now().toString(36).slice(-6)}`,
    protocol,
    scenario,
    summary: isHttp
      ? `${safeRaw.split(/\r?\n/)[0]} · ${scenario === 'response' ? 'server response' : 'client request'}`
      : `${scenario === 'handshake' ? 'TCP connection handshake' : 'TCP data segment'} · ${safeRaw.split(' | ')[0]}`,
    raw: safeRaw,
    hex: hexDump(safeRaw),
    fields: isHttp ? parseHttpFields(safeRaw) : parseTcpFields(safeRaw),
    timeline: timelineFor(protocol, scenario),
    inspection,
    metadata: {
      capturedAt: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      source: isHttp ? '10.0.0.24:51842' : safeRaw.split(' > ')[0].replace('TCP ', ''),
      destination: isHttp ? '10.0.0.8:443' : (safeRaw.split(' > ')[1]?.split(' | ')[0] ?? '10.0.0.8:443'),
      length: Buffer.byteLength(safeRaw, 'utf8'),
      checksum: checksum(safeRaw)
    }
  };
}

function isProtocol(value: unknown): value is Protocol { return value === 'HTTP' || value === 'TCP'; }
function isScenario(value: unknown): value is PacketScenario { return value === 'request' || value === 'response' || value === 'handshake'; }

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'network-packet-lab-api' }));

app.get('/api/simulate', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenario = isScenario(request.query.scenario) ? request.query.scenario : (protocol === 'HTTP' ? 'request' : 'handshake');
  response.json({ data: buildPacket(protocol, scenario, '') });
});

app.get('/api/packets', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenarios: PacketScenario[] = protocol === 'HTTP' ? ['request', 'response'] : ['handshake', 'request', 'response'];
  response.json({ data: scenarios.map((scenario) => buildPacket(protocol, scenario, '')) });
});

app.post('/api/parse', (request: Request<unknown, unknown, Partial<ParseRequest>>, response: Response) => {
  const protocol = isProtocol(request.body?.protocol) ? request.body.protocol : 'HTTP';
  const scenario = isScenario(request.body?.scenario) ? request.body.scenario : 'request';
  const raw = typeof request.body?.raw === 'string' ? request.body.raw : '';
  if (!raw.trim()) return response.status(400).json({ error: 'raw is required' });
  response.json({ data: buildPacket(protocol, scenario, raw) });
});

app.listen(port, () => {
  console.log(`Network Packet Lab API listening on http://localhost:${port}`);
});
