import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  InspectionDiagnostic,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  QueryParamInspection,
  RequestInspection,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'inspector' | 'hex'>('overview');
  const [highlightFieldId, setHighlightFieldId] = useState<string | null>(null);
  const [expandSignal, setExpandSignal] = useState(0);

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json() as Promise<{ data: SimulatedPacket }>;
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setLoading(true);
    setError('');
    try {
      const result = await request(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await request('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSample('HTTP', 'request');
  }, []);

  useEffect(() => {
    setHighlightFieldId(null);
  }, [packet?.id]);

  const navigateToField = (fieldId: string) => {
    setActiveView('overview');
    setHighlightFieldId(fieldId);
    setExpandSignal((value) => value + 1);
  };

  const changeProtocol = (nextProtocol: Protocol) => {
    const nextScenario = nextProtocol === 'TCP' && scenario === 'response' ? 'handshake' : scenario;
    setProtocol(nextProtocol);
    setScenario(nextScenario);
    void loadSample(nextProtocol, nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    setScenario(nextScenario);
    void loadSample(protocol, nextScenario);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据。</p>
          </div>
          <div className="hero-stat"><strong>{packet?.metadata.length ?? '—'}</strong><span>BYTES<br />CURRENT FRAME</span></div>
        </section>

        <section className="control-panel panel">
          <div className="control-group">
            <label>协议 <span>PROTOCOL</span></label>
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} className={protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="control-group scenario-control">
            <label>模拟场景 <span>SCENARIO</span></label>
            <select value={scenario} onChange={(event) => changeScenario(event.target.value as PacketScenario)}>
              {availableScenarios.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
            </select>
          </div>
          <div className="control-actions">
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{packet?.id ?? 'WAITING'}</span></div>
              <Timeline events={packet?.timeline ?? []} />
            </div>
          </div>

          <div className="right-column">
            <div className="panel packet-summary">
              <div className="summary-top"><div><p className="section-kicker">ACTIVE FRAME</p><h3>{packet?.summary ?? '等待数据包'}</h3></div><div className="live-chip"><i /> DECODED</div></div>
              <div className="metadata-grid">
                <Meta label="SOURCE" value={packet?.metadata.source ?? '—'} />
                <Meta label="DESTINATION" value={packet?.metadata.destination ?? '—'} />
                <Meta label="CAPTURED AT" value={packet?.metadata.capturedAt ?? '—'} />
                <Meta label="CHECKSUM" value={packet?.metadata.checksum ?? '—'} />
              </div>
            </div>

            <div className="panel details-panel">
              <div className="tabs">
                <button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button>
                <button className={activeView === 'inspector' ? 'selected' : ''} onClick={() => setActiveView('inspector')}>请求检查器</button>
                <button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button>
              </div>
              {activeView === 'overview'
                ? <FieldTree fields={packet?.fields ?? []} highlightId={highlightFieldId} expandSignal={expandSignal} />
                : activeView === 'inspector'
                  ? <RequestInspector inspection={packet?.inspection} onNavigate={navigateToField} />
                  : <HexView rows={packet?.hex ?? []} />}
            </div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function FieldTree({ fields, highlightId, expandSignal }: {
  fields: ProtocolField[];
  highlightId: string | null;
  expandSignal: number;
}) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return <div className="field-tree">{fields.map((field) => <FieldNode key={field.id} field={field} depth={0} highlightId={highlightId} expandSignal={expandSignal} />)}</div>;
}

function FieldNode({ field, depth, highlightId, expandSignal }: {
  field: ProtocolField;
  depth: number;
  highlightId: string | null;
  expandSignal: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(field.children?.length);
  const highlighted = field.id === highlightId;
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setExpanded(true);
  }, [expandSignal]);
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlighted, expandSignal]);
  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div ref={rowRef} className={`field-row${highlighted ? ' highlighted' : ''}`} onClick={() => hasChildren && setExpanded((value) => !value)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children!.map((child) => <FieldNode key={child.id} field={child} depth={depth + 1} highlightId={highlightId} expandSignal={expandSignal} />)}</div>}
  </div>;
}

const diagnosticLabels: Record<InspectionDiagnostic['code'], string> = {
  encoded: '已编码',
  'duplicate-key': '重复键',
  'no-value': '无值',
  'empty-value': '空值',
  'malformed-encoding': '编码异常'
};

function DiagnosticBadges({ diagnostics }: { diagnostics: InspectionDiagnostic[] }) {
  if (!diagnostics.length) return null;
  return <span className="diag-badges">
    {diagnostics.map((diagnostic, index) => (
      <span key={index} className={`diag diag-${diagnostic.severity}`} title={`${diagnostic.message}\n${diagnostic.messageEn}`}>
        {diagnosticLabels[diagnostic.code]}{diagnostic.offset !== undefined ? ` @${diagnostic.offset}` : ''}
      </span>
    ))}
  </span>;
}

function DiagnosticList({ diagnostics }: { diagnostics: InspectionDiagnostic[] }) {
  if (!diagnostics.length) return null;
  return <ul className="diag-list">
    {diagnostics.map((diagnostic, index) => (
      <li key={index} className={`diag-${diagnostic.severity}`}>{diagnostic.message}</li>
    ))}
  </ul>;
}

function RequestInspector({ inspection, onNavigate }: {
  inspection?: RequestInspection;
  onNavigate: (fieldId: string) => void;
}) {
  const [mode, setMode] = useState<'raw' | 'decoded'>('decoded');
  if (!inspection) return <div className="empty-state">解析后将在这里显示请求方法、路径、查询参数、Header 与 Body。</div>;
  if (!inspection.applicable) {
    return <div className="inspector-na">
      <span className="na-mark">N/A</span>
      <strong>不适用 · NOT APPLICABLE</strong>
      <p>{inspection.reason}</p>
      <p className="na-en">{inspection.reasonEn}</p>
    </div>;
  }

  const { method, path, query, duplicateKeys, headers, body, diagnostics } = inspection;
  const counts = diagnostics.reduce(
    (result, diagnostic) => ({ ...result, [diagnostic.severity]: result[diagnostic.severity] + 1 }),
    { error: 0, warning: 0, info: 0 }
  );

  const jumpToDuplicate = (key: string) => {
    const target = query?.params.find((param) => param.decodedKey === key);
    if (target) onNavigate(target.fieldId);
  };

  return <div className="inspector">
    <div className="inspector-toolbar">
      <span className="inspector-hint">点击任意条目可回到字段树对应节点 · Click an item to reveal it in the field tree</span>
      <div className="mode-toggle" role="group" aria-label="解码视图">
        <button className={mode === 'raw' ? 'active' : ''} onClick={() => setMode('raw')}>解码前 RAW</button>
        <button className={mode === 'decoded' ? 'active' : ''} onClick={() => setMode('decoded')}>解码后 DECODED</button>
      </div>
    </div>

    {(counts.error > 0 || counts.warning > 0 || counts.info > 0) && (
      <div className="inspector-summary">
        {counts.error > 0 && <span className="summary-chip error">⛔ {counts.error} 错误</span>}
        {counts.warning > 0 && <span className="summary-chip warning">⚠ {counts.warning} 警告</span>}
        {counts.info > 0 && <span className="summary-chip info">ℹ {counts.info} 提示</span>}
      </div>
    )}

    <section className="inspector-section">
      <h4>请求行 <span>REQUEST LINE</span></h4>
      <div className="inspector-list">
        <button type="button" className="inspector-row" onClick={() => onNavigate(method.fieldId)}>
          <span className="iq-label">Method</span>
          <code className="iq-value method-badge">{method.value}</code>
        </button>
        <div className="inspector-item">
          <button type="button" className="inspector-row" onClick={() => onNavigate(path.fieldId)}>
            <span className="iq-label">Path</span>
            <code className="iq-value">{mode === 'raw' ? path.raw : path.decoded}</code>
            <DiagnosticBadges diagnostics={path.diagnostics} />
          </button>
          <DiagnosticList diagnostics={path.diagnostics} />
        </div>
      </div>
    </section>

    <section className="inspector-section">
      <h4>Query 参数 <span>{query ? `${query.params.length} PARAMS` : 'NO QUERY'}</span></h4>
      {query ? <div className="inspector-list">
        {query.params.length === 0 && <p className="inspector-empty">“?” 之后没有任何参数。</p>}
        {query.params.map((param) => (
          <QueryParamRow key={param.id} param={param} mode={mode} onNavigate={onNavigate} />
        ))}
      </div> : <p className="inspector-empty">请求目标不包含 “?”，没有 query 字符串。</p>}
    </section>

    {duplicateKeys.length > 0 && (
      <div className="inspector-dupes">
        <strong>重复参数：</strong>
        {duplicateKeys.map((item) => (
          <button key={item.key} type="button" onClick={() => jumpToDuplicate(item.key)}>
            {item.key} × {item.count}
          </button>
        ))}
      </div>
    )}

    <section className="inspector-section">
      <h4>Headers <span>{headers.length} FIELDS</span></h4>
      <div className="inspector-list">
        {headers.length === 0 && <p className="inspector-empty">没有 Header 字段。</p>}
        {headers.map((header) => (
          <button key={header.id} type="button" className="inspector-row" onClick={() => onNavigate(header.fieldId)}>
            <span className="iq-label">{header.name}</span>
            <code className="iq-value">{header.value || '(empty)'}</code>
          </button>
        ))}
      </div>
    </section>

    <section className="inspector-section">
      <h4>Body <span>PAYLOAD</span></h4>
      <button type="button" className="inspector-row inspector-body-row" onClick={() => onNavigate(body.fieldId)}>
        <code className={`iq-value iq-body${body.value ? '' : ' no-value'}`}>{body.value || '(empty)'}</code>
      </button>
    </section>
  </div>;
}

function QueryParamRow({ param, mode, onNavigate }: {
  param: QueryParamInspection;
  mode: 'raw' | 'decoded';
  onNavigate: (fieldId: string) => void;
}) {
  const key = mode === 'raw' ? param.rawKey : param.decodedKey;
  const value = mode === 'raw' ? param.rawValue : param.decodedValue;
  return <div className="inspector-item">
    <button type="button" className="inspector-row" title={`原始文本 / raw: ${param.rawSegment}`} onClick={() => onNavigate(param.fieldId)}>
      <code className="iq-key">{key || '(empty key)'}</code>
      {value === null
        ? <code className="iq-value no-value">∅ 无值</code>
        : <>
          <span className="iq-eq">=</span>
          <code className={`iq-value${value ? '' : ' no-value'}`}>{value || '(empty)'}</code>
        </>}
      <DiagnosticBadges diagnostics={param.diagnostics} />
    </button>
    <DiagnosticList diagnostics={param.diagnostics} />
  </div>;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

function HexView({ rows }: { rows: SimulatedPacket['hex'] }) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  return <div className="hex-view"><div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span></div>{rows.map((row) => <div className="hex-row" key={row.offset}><code>{row.offset}</code><code>{row.bytes.join(' ')}</code><code className="ascii">{row.ascii}</code></div>)}</div>;
}

export default App;
