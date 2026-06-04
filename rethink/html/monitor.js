document.addEventListener('DOMContentLoaded', function () {})

// ── Shared ──────────────────────────────────────────────────────────────────
const baseUrl = new URL(window.location)
baseUrl.pathname = '/'
baseUrl.search = ''
baseUrl.hash = ''

function get(id) {
    return document.getElementById(id)
}

// ── Device MQTT panel ────────────────────────────────────────────────────────
let deviceWs
let deviceReconnectTimer

get('device_id').innerText = new URLSearchParams(window.location.search).get('id')
get('device_status').innerText = 'Waiting for rethink connection...'

function connectDevice() {
    clearTimeout(deviceReconnectTimer)
    deviceWs = new WebSocket(baseUrl + `device${window.location.search}`)

    deviceWs.onclose = () => {
        deviceReconnectTimer = setTimeout(connectDevice, 5000)
        get('device_status').innerText = 'Waiting for rethink connection...'
        get('btn_send1').disabled = true
        get('btn_send2').disabled = true
    }

    deviceWs.onopen = () => {
        get('device_status').innerText = 'offline'
    }

    deviceWs.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        const json = JSON.parse(ev.data)

        if (json.rx) {
            const div = pushDeviceMessage('rx', json.rx, json.injected)
            div.onclick = () => {
                get('send2').value = json.rx
                M.updateTextFields()
            }
        }

        if (json.tx) {
            const div = pushDeviceMessage('tx', json.tx, json.injected)
            div.onclick = () => {
                get('send1').value = json.tx
                M.updateTextFields()
            }
        }

        if (json.status) {
            get('device_status').innerText = json.status
            if (json.status === 'online') {
                get('btn_send1').disabled = false
                get('btn_send1').onclick = () => {
                    let cmd = get('send1').value
                    if (cmd[0] === '{') cmd = JSON.parse(cmd)
                    deviceWs.send(JSON.stringify({ sendToDevice: cmd }))
                }
                get('btn_send2').disabled = false
                get('btn_send2').onclick = () => {
                    deviceWs.send(JSON.stringify({ sendFromDevice: get('send2').value }))
                }
            } else {
                get('btn_send1').disabled = true
                get('btn_send2').disabled = true
            }
        }

        if (json.meta) {
            get('device_model').innerText = json.meta.modelId
        }
    }
}

function pushDeviceMessage(direction, payload, injected) {
    const messages = get('messages')
    const div = document.createElement('div')
    div.classList.add(direction, 'message')
    if (injected) div.classList.add('injected')
    div.innerText = payload

    const timestamp = document.createElement('span')
    timestamp.innerText = new Date().toLocaleTimeString()
    timestamp.classList.add('timestamp')
    div.appendChild(timestamp)

    messages.appendChild(div)
    if (get('autoscroll').checked) messages.scrollTop = messages.scrollHeight
    return div
}

// ── LG Cloud MQTT panel ──────────────────────────────────────────────────────
let cloudWs
let cloudReconnectTimer
let cloudMessageCount = 0

const CLOUD_STATUS_LABELS = {
    idle: { text: 'Idle', cls: '' },
    connecting: { text: 'Connecting…', cls: 'warn' },
    reconnecting: { text: 'Reconnecting…', cls: 'warn' },
    connected: { text: 'Connected ✓', cls: 'ok' },
    'not-logged-in': { text: 'Not logged in — use the login form below', cls: 'err' },
}

function setCloudStatus(raw) {
    const el = get('cloud_status')
    const known = CLOUD_STATUS_LABELS[raw]
    el.innerText = known ? known.text : raw
    el.className = 'status_value' + (known?.cls ? ' ' + known.cls : '')
    get('cloud_login').style.display = raw === 'not-logged-in' ? 'block' : 'none'
    if (!known) pushCloudLog(raw)
}

// ── Cloud login flow ─────────────────────────────────────────────────────────
get('btn_cloud_login').onclick = () => {
    const cc = get('cloud_cc').value.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(cc)) {
        M.toast({ html: 'Enter a 2-letter country code first' })
        return
    }
    window.open(baseUrl + 'lgcloud_login?countryCode=' + cc, '_blank')
}

get('btn_cloud_login_complete').onclick = async () => {
    const url = get('cloud_login_url').value.trim()
    const cc = get('cloud_cc').value.trim().toUpperCase()
    if (!url || !/^[A-Z]{2}$/.test(cc)) {
        M.toast({ html: 'Enter country code and paste the post-login URL' })
        return
    }
    const btn = get('btn_cloud_login_complete')
    btn.disabled = true
    try {
        const resp = await fetch(baseUrl + 'lgcloud_login_accept', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url, countryCode: cc }),
        })
        if (!resp.ok) {
            const msg = await resp.text().catch(() => String(resp.status))
            M.toast({ html: 'Login failed: ' + msg })
        } else {
            get('cloud_login').style.display = 'none'
            setCloudStatus('connecting')
        }
    } catch (err) {
        M.toast({ html: 'Login error: ' + err.message })
    } finally {
        btn.disabled = false
    }
}

function connectCloud() {
    clearTimeout(cloudReconnectTimer)
    cloudWs = new WebSocket(baseUrl + 'lgcloud')

    cloudWs.onclose = () => {
        setCloudStatus('idle')
        cloudReconnectTimer = setTimeout(connectCloud, 5000)
    }

    cloudWs.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        const json = JSON.parse(ev.data)

        if (json.cloudStatus !== undefined) {
            setCloudStatus(json.cloudStatus)
        }

        if (json.cloud) {
            pushCloudMessage(json.cloud)
        }
    }
}

function pushCloudMessage(msg) {
    const feed = get('cloud_messages')

    const wrapper = document.createElement('div')
    wrapper.className = 'cloud-message'

    const topicEl = document.createElement('div')
    topicEl.className = 'cloud-topic'

    const ts = document.createElement('span')
    ts.className = 'cloud-ts'
    ts.innerText = new Date().toLocaleTimeString()
    topicEl.appendChild(ts)
    topicEl.appendChild(document.createTextNode(msg.topic))
    wrapper.appendChild(topicEl)

    const pre = document.createElement('pre')
    pre.innerText = msg.payload !== null ? JSON.stringify(msg.payload, null, 2) : msg.raw
    wrapper.appendChild(pre)

    feed.appendChild(wrapper)

    cloudMessageCount++
    get('cloud_count').innerText = String(cloudMessageCount)

    if (get('cloud_autoscroll').checked) feed.scrollTop = feed.scrollHeight
}

function pushCloudLog(text) {
    const feed = get('cloud_messages')
    const div = document.createElement('div')
    div.className = 'cloud-status-line'
    div.innerText = new Date().toLocaleTimeString() + '  ' + text
    feed.appendChild(div)
    if (get('cloud_autoscroll').checked) feed.scrollTop = feed.scrollHeight
}

// ── Boot ─────────────────────────────────────────────────────────────────────
connectDevice()
connectCloud()
