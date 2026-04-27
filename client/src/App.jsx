import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const ENGINE_SCRIPT_URL = '/crdt_engine.js';
// Vite inlines `import.meta.env.VITE_*` at build time, so we point to the
// deployed Render backend in production and fall back to localhost in dev.
// Set VITE_BACKEND_URL on Vercel (e.g. https://crdt-relay.onrender.com).
const SERVER_URL =
  import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// Embind binds CRDT_Character as a value_object, so the JS-side object is a
// plain object — *but* its `position` field is a live VectorInt handle that
// owns memory inside the WASM heap. We must drain it into a JS array and
// free the handle, otherwise every CRDT op leaks ints proportional to the
// position-vector depth.
const serializeChar = (cppChar) => {
  const posVec = cppChar.position;
  const posArray = [];
  try {
    for (let i = 0; i < posVec.size(); i++) {
      posArray.push(posVec.get(i));
    }
  } finally {
    posVec.delete();
  }
  return {
    value: cppChar.value,
    position: posArray,
    lamport_clock: cppChar.lamport_clock,
    client_id: cppChar.client_id,
    is_deleted: cppChar.is_deleted,
  };
};

// Caller owns the returned VectorInt and is responsible for .delete()-ing it
// after passing it into a C++ method (typically inside a try/finally).
const jsArrayToVector = (jsArray, engineModule) => {
  const vec = new engineModule.VectorInt();
  for (const num of jsArray) {
    vec.push_back(num);
  }
  return vec;
};

const fetchInitialDocument = async () => {
  const res = await fetch(`${SERVER_URL}/api/document`);
  if (!res.ok) {
    throw new Error(`GET /api/document → HTTP ${res.status}`);
  }
  const body = await res.json();
  return Array.isArray(body.characters) ? body.characters : [];
};

const replayCharacters = (Module, engine, characters) => {
  if (!Array.isArray(characters) || characters.length === 0) return;

  for (const ch of characters) {
    if (
      !ch ||
      !Array.isArray(ch.position) ||
      ch.position.length === 0 ||
      typeof ch.value !== 'string'
    ) {
      console.warn('Skipping malformed character record:', ch);
      continue;
    }

    const cppVector = jsArrayToVector(ch.position, Module);
    try {
      engine.loadFromDatabase(
        ch.value,
        cppVector,
        Number.isFinite(ch.lamport_clock) ? ch.lamport_clock : 0,
        typeof ch.client_id === 'string' ? ch.client_id : '',
        Boolean(ch.is_deleted)
      );
    } finally {
      cppVector.delete();
    }
  }
};

function App() {
  const [engine, setEngine] = useState(null);
  const [moduleRef, setModuleRef] = useState(null);
  const [siteId, setSiteId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  const previousTextRef = useRef('');
  const socketRef = useRef(null);

  const refreshFromEngine = useCallback((eng) => {
    const updated = eng.getText();
    previousTextRef.current = updated;
    setText(updated);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let injectedScript = null;

    const init = async () => {
      try {
        const initialCharacters = await fetchInitialDocument();
        if (cancelled) return;

        if (!window.createCRDTModule) {
          await new Promise((resolve, reject) => {
            const existing = document.querySelector(
              `script[data-crdt-engine="true"]`
            );
            if (existing) {
              existing.addEventListener('load', resolve, { once: true });
              existing.addEventListener('error', reject, { once: true });
              return;
            }

            const script = document.createElement('script');
            script.src = ENGINE_SCRIPT_URL;
            script.async = true;
            script.dataset.crdtEngine = 'true';
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', () =>
              reject(new Error(`Failed to load ${ENGINE_SCRIPT_URL}`))
            );
            document.body.appendChild(script);
            injectedScript = script;
          });
        }
        if (cancelled) return;

        const Module = await window.createCRDTModule();
        if (cancelled) return;

        const newSiteId = 'User_' + Math.random().toString(36).slice(2, 10);
        const instance = new Module.CRDT_Engine(newSiteId);

        replayCharacters(Module, instance, initialCharacters);

        const initialText = instance.getText();
        previousTextRef.current = initialText;

        setText(initialText);
        setSiteId(newSiteId);
        setModuleRef(Module);
        setEngine(instance);
      } catch (err) {
        console.error('CRDT initialisation failed:', err);
        if (!cancelled) setError(err.message || String(err));
      }
    };

    init();

    return () => {
      cancelled = true;
      if (injectedScript && injectedScript.parentNode) {
        injectedScript.parentNode.removeChild(injectedScript);
      }
    };
  }, []);

  useEffect(() => {
    if (!engine || !moduleRef) return;

    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);
    const handleConnectError = (err) => {
      console.error('Socket connect error:', err.message);
      setConnected(false);
    };

    const handleRemoteInsert = (payload) => {
      if (!payload || !Array.isArray(payload.position)) return;
      // Build a fresh WASM-side VectorInt for the position; we own this
      // handle and must release it in finally even if remoteInsert throws.
      const cppVector = jsArrayToVector(payload.position, moduleRef);
      try {
        engine.remoteInsert(
          payload.value,
          cppVector,
          payload.lamport_clock,
          payload.client_id
        );
      } finally {
        cppVector.delete();
      }
      refreshFromEngine(engine);
    };

    const handleRemoteDelete = (payload) => {
      if (!payload || !Array.isArray(payload.position)) return;
      const cppVector = jsArrayToVector(payload.position, moduleRef);
      try {
        engine.remoteDelete(cppVector, payload.client_id);
      } finally {
        cppVector.delete();
      }
      refreshFromEngine(engine);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('crdt_operation', handleRemoteInsert);
    socket.on('crdt_delete', handleRemoteDelete);

    // Detach each listener by reference so that under StrictMode
    // double-invocation (or any re-render that retriggers this effect) we
    // don't end up with duplicate handlers replaying the same op twice.
    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('crdt_operation', handleRemoteInsert);
      socket.off('crdt_delete', handleRemoteDelete);
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [engine, moduleRef, refreshFromEngine]);

  const handleChange = (event) => {
    if (!engine) return;

    const newText = event.target.value;
    const oldText = text;
    const socket = socketRef.current;

    let prefix = 0;
    const maxPrefix = Math.min(oldText.length, newText.length);
    while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
      prefix++;
    }

    let suffix = 0;
    const maxSuffix = Math.min(
      oldText.length - prefix,
      newText.length - prefix
    );
    while (
      suffix < maxSuffix &&
      oldText[oldText.length - 1 - suffix] ===
        newText[newText.length - 1 - suffix]
    ) {
      suffix++;
    }

    // Note: localInsert/localDelete return CRDT_Character as an Embind
    // value_object (a plain JS object, not a handle) so we don't call
    // .delete() on it — but its `position` field IS a VectorInt handle,
    // and serializeChar drains+frees that handle synchronously below.
    const deleteEnd = oldText.length - suffix;
    for (let index = deleteEnd - 1; index >= prefix; index--) {
      const deleted = engine.localDelete(index);
      const wire = serializeChar(deleted);
      if (wire.position.length === 0) continue;
      if (socket && socket.connected) {
        socket.emit('crdt_delete', wire);
      }
    }

    const insertEnd = newText.length - suffix;
    for (let index = prefix; index < insertEnd; index++) {
      const inserted = engine.localInsert(index, newText[index]);
      const wire = serializeChar(inserted);
      if (wire.position.length === 0) continue;
      if (socket && socket.connected) {
        socket.emit('crdt_operation', wire);
      }
    }

    const updated = engine.getText();
    previousTextRef.current = updated;
    setText(updated);
  };

  const handleSave = useCallback(async () => {
    if (!engine || saving) return;
    setSaving(true);
    setSaveStatus(null);

    // exportState returns a VectorCharacter handle that owns the entire
    // copy of the document. We free it in `finally` to guarantee no leak
    // even if serializeChar / fetch throws mid-iteration.
    let stateVec = null;
    try {
      stateVec = engine.exportState();
      const size = stateVec.size();
      const characters = new Array(size);
      for (let i = 0; i < size; i++) {
        characters[i] = serializeChar(stateVec.get(i));
      }

      const res = await fetch(`${SERVER_URL}/api/document/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characters }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSaveStatus(`Saved ${body.count ?? characters.length} characters`);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveStatus(`Save failed: ${err.message}`);
    } finally {
      if (stateVec) stateVec.delete();
      setSaving(false);
    }
  }, [engine, saving]);

  const isOnline = Boolean(engine) && connected;

  return (
    <div className="flex h-screen flex-col bg-gray-900 font-sans text-gray-100">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/5 bg-gray-900/80 px-6 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-purple-600 text-sm font-bold tracking-tight text-white shadow-md">
            S
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight text-gray-50">
              SyncSpace CRDT Editor
            </span>
            {siteId && (
              <span className="text-[11px] text-gray-500">
                site <code className="rounded bg-white/5 px-1 py-px font-mono text-[10px] text-gray-300">{siteId}</code>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 rounded-full border border-white/5 bg-white/5 px-3 py-1.5 text-xs">
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  isOnline ? 'animate-ping bg-emerald-400' : 'bg-rose-500'
                }`}
              />
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  isOnline ? 'bg-emerald-400' : 'bg-rose-500'
                }`}
              />
            </span>
            <span className={isOnline ? 'text-emerald-300' : 'text-rose-300'}>
              {!engine ? 'booting' : connected ? 'connected' : 'offline'}
            </span>
          </div>

          {saveStatus && (
            <span className="hidden text-xs text-gray-400 sm:inline">
              {saveStatus}
            </span>
          )}

          <button
            className="inline-flex items-center gap-2 rounded-md bg-indigo-500 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-indigo-400 active:translate-y-px disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
            type="button"
            onClick={handleSave}
            disabled={!engine || saving}
          >
            {saving ? (
              <>
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeOpacity="0.25"
                    strokeWidth="3"
                  />
                  <path
                    d="M22 12a10 10 0 0 1-10 10"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
                Saving…
              </>
            ) : (
              'Save Document'
            )}
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-rose-500/20 bg-rose-500/10 px-6 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      <main className="flex flex-1 justify-center overflow-hidden px-6 py-8">
        <div className="flex w-full max-w-4xl flex-col">
          <textarea
            className="flex-1 resize-none rounded-xl border border-white/5 bg-gray-800 px-8 py-6 font-mono text-[15px] leading-7 text-gray-100 shadow-2xl shadow-black/30 outline-none ring-0 placeholder:text-gray-500 focus:border-indigo-500/40 focus:ring-2 focus:ring-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            value={text}
            onChange={handleChange}
            disabled={!engine || !connected}
            placeholder={
              !engine
                ? 'Loading engine…'
                : !connected
                ? 'Reconnecting to relay server… edits paused to avoid divergence.'
                : 'Start typing — every keystroke flows through the CRDT…'
            }
            spellCheck={false}
            rows={20}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
