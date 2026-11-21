import { stripHeader } from './text.js'

export const MAX_COMMENTARY_CHARS = 1600

export function formatCommentary(text) {
  if (!text) return ''
  const plain = stripHeader(String(text))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= MAX_COMMENTARY_CHARS) return plain
  return `${plain.slice(0, MAX_COMMENTARY_CHARS - 1).trimEnd()}…`
}

export function createCommentaryEvent(delegationId, text) {
  return {
    type: 'session.commentary.append',
    event_id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    delegation_id: delegationId ?? null,
    content: formatCommentary(text),
  }
}

export function waitForIceGathering(pc, timeoutMs = 2000) {
  if (!pc || pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (typeof pc.removeEventListener === 'function') {
        pc.removeEventListener('icegatheringstatechange', onChange)
      } else if (pc.onicegatheringstatechange === onChange) {
        pc.onicegatheringstatechange = null
      }
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, timeoutMs)
    if (typeof pc.addEventListener === 'function') {
      pc.addEventListener('icegatheringstatechange', onChange)
    } else {
      pc.onicegatheringstatechange = onChange
    }
  })
}

export async function openLiveVoiceSession({
  sessionId,
  model,
  voice,
  idleTimeoutS,
  vadThreshold,
  createSession,
  closeSession,
  onEvent,
  onPhase,
  onTranscript,
  onTranscriptCommit,
  onLevel,
  onDelegation,
  onError,
  mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
  PeerConnection = globalThis.RTCPeerConnection,
  createAudioElement,
  AudioContextImpl = globalThis.AudioContext ?? globalThis.webkitAudioContext,
} = {}) {
  if (!mediaDevices?.getUserMedia || typeof PeerConnection !== 'function') {
    throw Object.assign(new Error('unavailable'), { kind: 'unavailable' })
  }
  if (typeof createSession !== 'function') {
    throw Object.assign(new Error('createSession is required'), { kind: 'unavailable' })
  }

  let stream
  try {
    stream = await mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
  } catch (error) {
    const kind = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError' ? 'blocked' : 'failed'
    throw Object.assign(new Error(kind), { kind, cause: error })
  }

  let closed = false
  let liveSessionId = null
  let currentPhase = 'connecting'
  let inputText = ''
  let outputText = ''
  let delegatedThisTurn = false
  let committedInput = false
  let committedOutput = false
  let rafId = 0
  let audioEl = null
  let audioCtx = null
  let pc = null
  let dc = null

  const setPhase = (next) => {
    currentPhase = next
    onPhase?.(next)
  }

  const cleanup = ({ notifyClose = true } = {}) => {
    if (closed) return
    closed = true
    if (rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    try { stream?.getTracks?.().forEach(track => track.stop()) } catch {}
    if (audioCtx) {
      void Promise.resolve(audioCtx.close?.()).catch(() => {})
      audioCtx = null
    }
    if (audioEl) {
      try { audioEl.pause?.() } catch {}
      try { audioEl.srcObject = null } catch {}
      try { audioEl.remove?.() } catch {}
      audioEl = null
    }
    try { dc?.close?.() } catch {}
    try { pc?.close?.() } catch {}
    onLevel?.(0)
    if (notifyClose && liveSessionId) {
      const id = liveSessionId
      liveSessionId = null
      void Promise.resolve(closeSession?.(id)).catch(() => {})
    }
  }

  try {
    pc = new PeerConnection()
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream)
    }

    dc = pc.createDataChannel('oai-events')

    pc.ontrack = (event) => {
      if (closed) return
      const remoteStream = event.streams?.[0] ?? (typeof MediaStream === 'function' && event.track ? new MediaStream([event.track]) : null)
      if (!remoteStream) return
      if (!audioEl) {
        audioEl = typeof createAudioElement === 'function'
          ? createAudioElement()
          : (typeof document !== 'undefined' ? document.createElement('audio') : null)
      }
      if (audioEl) {
        audioEl.autoplay = true
        audioEl.playsInline = true
        audioEl.srcObject = remoteStream
        void Promise.resolve(audioEl.play?.()).catch(() => {})
      }
    }

    pc.onconnectionstatechange = () => {
      if (closed) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        onError?.('Voice connection lost')
      }
    }

    dc.onmessage = (message) => {
      if (closed) return
      let event
      try {
        event = typeof message.data === 'string' ? JSON.parse(message.data) : message.data
      } catch {
        return
      }
      if (!event || typeof event !== 'object') return
      onEvent?.(event)

      const commitInput = () => {
        if (committedInput || delegatedThisTurn) return
        const text = inputText.trim()
        if (!text) return
        committedInput = true
        onTranscriptCommit?.({ role: 'user', text })
      }
      const commitOutput = () => {
        if (committedOutput || delegatedThisTurn) return
        const text = outputText.trim()
        if (!text) return
        committedOutput = true
        onTranscriptCommit?.({ role: 'assistant', text })
      }

      switch (event.type) {
        case 'session.started':
          setPhase('listening')
          break
        case 'session.paused':
          // Keep the microphone track active during Standby so speech wakes the model.
          setPhase('standby')
          break
        case 'session.resumed':
          setPhase('listening')
          break
        case 'input_audio_buffer.speech_started':
        case 'session.input_speech.started':
          inputText = ''
          outputText = ''
          delegatedThisTurn = false
          committedInput = false
          committedOutput = false
          setPhase('listening')
          break
        case 'session.input_transcript.delta':
          inputText += String(event.delta ?? '')
          onTranscript?.({ role: 'user', text: inputText })
          break
        case 'session.input_transcript.done':
          commitInput()
          break
        case 'conversation.item.input_audio_transcription.completed':
          inputText = String(event.transcript ?? '')
          onTranscript?.({ role: 'user', text: inputText })
          commitInput()
          break
        case 'session.output_transcript.delta':
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta':
          commitInput()
          outputText += String(event.delta ?? '')
          onTranscript?.({ role: 'assistant', text: outputText })
          setPhase('speaking')
          break
        case 'session.output_transcript.done':
        case 'response.done':
          commitOutput()
          if (currentPhase === 'speaking') setPhase('listening')
          break
        case 'session.delegation.created': {
          delegatedThisTurn = true
          const delegationId = event.delegation?.id ?? event.delegation_id ?? null
          const query = String(event.delegation?.query ?? event.delegation?.input ?? event.delegation?.prompt ?? inputText).trim()
          onDelegation?.({ delegationId, query, event })
          break
        }
        case 'error':
          onError?.(event.error?.message ?? event.message ?? 'Voice session error')
          break
        default:
          break
      }
    }

    if (typeof AudioContextImpl === 'function' && typeof requestAnimationFrame === 'function') {
      try {
        audioCtx = new AudioContextImpl()
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        audioCtx.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)
        let smooth = 0
        const tick = () => {
          if (closed) return
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (const value of data) sum += ((value - 128) / 128) ** 2
          smooth = smooth * 0.8 + Math.min(1, Math.sqrt(sum / data.length) * 4) * 0.2
          onLevel?.(Math.round(smooth * 100) / 100)
          rafId = requestAnimationFrame(tick)
        }
        tick()
      } catch {}
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIceGathering(pc)

    const sdpOffer = pc.localDescription?.sdp ?? offer?.sdp
    const meta = await createSession({
      sessionId,
      sdp: sdpOffer,
      ...(model ? { model } : {}),
      ...(voice ? { voice } : {}),
      ...(idleTimeoutS !== undefined ? { idleTimeoutS } : {}),
      ...(vadThreshold !== undefined ? { vadThreshold } : {}),
      standby: true,
    })

    if (closed) {
      if (meta?.liveSessionId) void Promise.resolve(closeSession?.(meta.liveSessionId)).catch(() => {})
      throw new Error('Voice session closed during setup')
    }

    liveSessionId = meta.liveSessionId
    await pc.setRemoteDescription({ type: 'answer', sdp: meta.sdp })

    if (closed) {
      cleanup({ notifyClose: true })
      throw new Error('Voice session closed during setup')
    }

    const setMuted = (muted) => {
      const tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : stream.getTracks()
      for (const track of tracks) track.enabled = !muted
    }

    const sendEvent = (obj) => {
      if (closed || !dc || dc.readyState !== 'open') return false
      dc.send(JSON.stringify(obj))
      return true
    }

    const sendCommentary = (delegationId, text) => {
      const event = createCommentaryEvent(delegationId, text)
      if (!event.content) return false
      return sendEvent(event)
    }

    return {
      liveSessionId,
      meta,
      setMuted,
      sendEvent,
      sendCommentary,
      close: () => cleanup({ notifyClose: true }),
    }
  } catch (error) {
    cleanup({ notifyClose: true })
    throw error
  }
}
