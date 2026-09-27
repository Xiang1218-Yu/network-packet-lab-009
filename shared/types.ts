export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
  children?: ProtocolField[];
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  phase: 'ingress' | 'parse' | 'transport' | 'application' | 'egress';
  detail: string;
}

export type InspectionSeverity = 'info' | 'warning' | 'error';

export type InspectionCode =
  | 'encoded'
  | 'duplicate-key'
  | 'no-value'
  | 'empty-value'
  | 'malformed-encoding';

export interface InspectionDiagnostic {
  code: InspectionCode;
  severity: InspectionSeverity;
  message: string;
  messageEn: string;
  /** Offset within the raw request target, for localized diagnostics. */
  offset?: number;
}

export interface QueryParamInspection {
  id: string;
  index: number;
  /** Original `key=value` segment, kept verbatim from the raw request target. */
  rawSegment: string;
  rawKey: string;
  decodedKey: string;
  /** Null when the parameter has no `=` at all. */
  rawValue: string | null;
  decodedValue: string | null;
  diagnostics: InspectionDiagnostic[];
  /** ProtocolField id this parameter maps to in the field tree. */
  fieldId: string;
}

export interface HeaderInspection {
  id: string;
  index: number;
  name: string;
  value: string;
  fieldId: string;
}

export interface RequestInspectionNotApplicable {
  applicable: false;
  reason: string;
  reasonEn: string;
}

export interface RequestInspectionData {
  applicable: true;
  method: { value: string; fieldId: string };
  target: string;
  path: {
    raw: string;
    decoded: string;
    diagnostics: InspectionDiagnostic[];
    fieldId: string;
  };
  /** Null when the request target carries no `?` query component. */
  query: {
    raw: string;
    fieldId: string;
    params: QueryParamInspection[];
  } | null;
  duplicateKeys: { key: string; count: number }[];
  headers: HeaderInspection[];
  body: { value: string; fieldId: string };
  /** Flattened diagnostics across every inspected field. */
  diagnostics: InspectionDiagnostic[];
}

export type RequestInspection = RequestInspectionNotApplicable | RequestInspectionData;

export interface SimulatedPacket {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  raw: string;
  hex: HexRow[];
  fields: ProtocolField[];
  timeline: TimelineEvent[];
  /** Semantic request inspector; not applicable for TCP frames and HTTP responses. */
  inspection: RequestInspection;
  metadata: {
    capturedAt: string;
    source: string;
    destination: string;
    length: number;
    checksum: string;
  };
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
}
