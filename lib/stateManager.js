const availableInputs = require('./inputs')
const { exec } = require('child_process')

const clampVolumePercent = v => {
	if (!Number.isFinite(v)) return 0
	if (v < 0) return 0
	if (v > 100) return 100
	return v
}

// Read each receiver field independently so a single command being unsupported
// (e.g. ZVL on a receiver that does not implement it, or a zone that is off
// not responding to a query) does not blow up the whole state read.
async function safeRead(label, device, fn, fallback) {
	try {
		return await fn()
	} catch (err) {
		// Track per-zone "never log this command again after the first miss"
		// so the log does not spam every poll cycle for unsupported commands.
		device._failedFields = device._failedFields || new Set()
		const key = `${device.zone || 'main'}:${label}`
		if (!device._failedFields.has(key)) {
			device._failedFields.add(key)
			device.log.easyDebug(`${device.name} - ${label} unavailable: ${err.message || err}. Will use fallback for subsequent reads.`)
		}
		return fallback
	}
}

module.exports = {

	getState: async function() {
		this.log.easyDebug(`${this.name} - Getting State`)
		const cached = this.cachedStates[this.id] || { power: 0, volume: 0, mute: false, source: 0 }

		const [power, rawVolume, mute, sourceKey] = await Promise.all([
			safeRead('power', this, () => this.avr.isOn(this.zone), !!cached.power),
			safeRead('volume', this, () => this.avr.getVolume(this.zone), null),
			safeRead('mute', this, () => this.avr.getMute(this.zone), cached.mute),
			safeRead('source', this, () => this.avr.getSource(this.zone), null)
		])

		const state = {
			power: power ? 1 : 0,
			volume: rawVolume == null
				? cached.volume
				: clampVolumePercent(Math.round(rawVolume / this.maxVolume * 100)),
			mute: mute,
			source: sourceKey == null
				? cached.source
				: availableInputs[this.zone].indexOf(sourceKey)
		}
		// indexOf returns -1 when the receiver reports an input that is not in
		// the static list. Fall back to cached source rather than a -1 that
		// HomeKit would reject as an illegal Identifier value.
		if (state.source < 0) state.source = cached.source

		this.log.easyDebug(`${this.name} - Got New State: ${JSON.stringify(state)}`)
		this.cachedStates[this.id] = state
		await this.storage.setItem('cachedStates', this.cachedStates)
		return state
	},

	set: {

		Active: function(state, callback) {
			if (state) {
				this.log(`${this.name}  - Turning ON`)
				if (this.customPowerOn) {
					this.log.easyDebug(`${this.name} - running customPowerOn: ${this.customPowerOn}`)
					exec(this.customPowerOn, (err) => {
						if (err) this.log(`customPowerOn failed: ${err.message}`)
					})
				} else {
					this.avr.pwrOn(this.zone)
				}
			} else {
				this.log(`${this.name} - Turning OFF`)
				if (this.customPowerOff) {
					this.log.easyDebug(`${this.name} - running customPowerOff: ${this.customPowerOff}`)
					exec(this.customPowerOff, (err) => {
						if (err) this.log(`customPowerOff failed: ${err.message}`)
					})
				} else {
					this.avr.pwrOff(this.zone)
				}
			}

			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		},

		ActiveIdentifier: function(identifier, callback) {
			const source = availableInputs[this.zone][identifier]
			this.log(`${this.name} - Setting Source to "${source}"`)
			this.avr.setSource(source, this.zone)
			
			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		},

		RemoteKey: function(key, callback) {
			const RemoteKey = this.api.hap.Characteristic.RemoteKey
			switch (key) {
				case RemoteKey.ARROW_UP:
					this.log(`${this.name} - Sending Remote Key: "UP"`)
					this.avr.sendRemoteKey("UP")
					break;
				case RemoteKey.ARROW_DOWN:
					this.log(`${this.name} - Sending Remote Key: "DOWN"`)
					this.avr.sendRemoteKey("DOWN")
					break;
				case RemoteKey.ARROW_RIGHT:
					this.log(`${this.name} - Sending Remote Key: "RIGHT"`)
					this.avr.sendRemoteKey("RIGHT")
					break;
				case RemoteKey.ARROW_LEFT:
					this.log(`${this.name} - Sending Remote Key: "LEFT"`)
					this.avr.sendRemoteKey("LEFT")
					break;
				case RemoteKey.SELECT:
					this.log(`${this.name} - Sending Remote Key: "ENTER"`)
					this.avr.sendRemoteKey("ENTER")
					break;
				case RemoteKey.BACK:
					this.log(`${this.name} - Sending Remote Key: "EXIT"`)
					this.avr.sendRemoteKey("EXIT")
					break;
				case RemoteKey.INFORMATION:
					this.log(`${this.name} - Sending Remote Key: "MENU"`)
					this.avr.sendRemoteKey("MENU")
					break;
				case RemoteKey.PLAY_PAUSE:
					this.log(`${this.name} - PLAY/PAUSE command is not available`)
					break;
				default:
			}
			
			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		},

		Volume: function(volume, callback) {
			const mappedVolume = Math.round(this.maxVolume / 100 * clampVolumePercent(volume))
			this.log(`${this.name} - Setting Volume to "${mappedVolume}"`)
			this.avr.setVolume(mappedVolume, this.zone)
			
			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		},

		Mute: function(mute, callback) {
			if (mute) {
				this.log(`${this.name} - Setting Mute ON`)
				this.avr.mute(this.zone)
			} else {
				this.log(`${this.name} - Setting Mute OFF`)
				this.avr.unMute(this.zone)
			}
			
			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		},

		VolumeSelector: function(decrement, callback) {
			if (decrement) {
				this.log(`${this.name} - Decrementing Volume by 1`)
				this.avr.volDown(this.zone)
			} else {
				this.log(`${this.name} - Incrementing Volume by 1`)
				this.avr.volUp(this.zone)
			}
			
			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		},

		ExternalVolume: function(volume, callback) {
			const mappedVolume = Math.round(this.maxVolume / 100 * clampVolumePercent(volume))
			this.log(`${this.name} (Ext.) - Setting Volume to "${mappedVolume}"`)
			this.avr.setVolume(mappedVolume, this.zone)
			
			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		},

		ExternalMute: function(unmute, callback) {
			if (!unmute) {
				this.log(`${this.name} (Ext.) - Setting Mute ON`)
				this.avr.mute(this.zone)
			} else {
				this.log(`${this.name} (Ext.) - Setting Mute OFF`)
				this.avr.unMute(this.zone)
			}
			
			setTimeout(() => {
				this.updateState()
			}, 2000)
			callback()
		}
	}
}