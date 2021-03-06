// To read notes about the master locking scheme, check out:
//   https://github.com/resque/resque-scheduler/blob/master/lib/resque/scheduler/locking.rb

const EventEmitter = require('events').EventEmitter
const os = require('os')
const Queue = require('./queue.js').Queue

class Scheduler extends EventEmitter {
  constructor (options, jobs) {
    super()
    if (!jobs) { jobs = {} }

    const defaults = {
      timeout: 5000, // in ms
      stuckWorkerTimeout: 60 * 60 * 1000, // 60 minutes in ms
      masterLockTimeout: 60 * 3, // in seconds
      name: os.hostname() + ':' + process.pid // assumes only one worker per node process
    }

    for (const i in defaults) {
      if (options[i] === null || options[i] === undefined) { options[i] = defaults[i] }
    }

    this.options = options
    this.name = this.options.name
    this.master = false
    this.running = false
    this.processing = false

    this.queue = new Queue({ connection: options.connection }, jobs)
    this.queue.on('error', (error) => { this.emit('error', error) })
  }

  async connect () {
    await this.queue.connect()
    this.connection = this.queue.connection
  }

  async start () {
    this.processing = false

    if (!this.running) {
      this.emit('start')
      this.running = true
      this.pollAgainLater()
    }
  }

  async end () {
    this.running = false
    clearTimeout(this.timer)

    if (this.processing === false) {
      if (this.connection && (
        this.connection.connected === true || this.connection.connected === undefined || this.connection.connected === null)
      ) {
        try {
          await this.releaseMasterLock()
        } catch (error) {
          this.emit('error', error)
        }
      }

      try {
        await this.queue.end()
      } catch (error) {
        this.emit('error', error)
      }
      this.emit('end')
    } else {
      return new Promise((resolve) => {
        setTimeout(async () => {
          await this.end()
          resolve()
        }, (this.options.timeout / 2))
      })
    }
  }

  async poll () {
    this.processing = true
    clearTimeout(this.timer)
    const isMaster = await this.tryForMaster()

    if (!isMaster) {
      this.master = false
      this.processing = false
      return this.pollAgainLater()
    }

    if (!this.master) {
      this.master = true
      this.emit('master')
    }

    this.emit('poll')
    const timestamp = await this.nextDelayedTimestamp()
    if (timestamp) {
      this.emit('workingTimestamp', timestamp)
      await this.enqueueDelayedItemsForTimestamp(timestamp)
      return this.poll()
    } else {
      await this.checkStuckWorkers()
      this.processing = false
      return this.pollAgainLater()
    }
  }

  async pollAgainLater () {
    if (this.running === true) {
      this.timer = setTimeout(() => { this.poll() }, this.options.timeout)
    }
  }

  masterKey () {
    return this.connection.key('resque_scheduler_master_lock')
  }

  async tryForMaster () {
    const masterKey = this.masterKey()
    if (!this.connection || !this.connection.redis) { return }

    const lockedByMe = await this.connection.redis.set(masterKey, this.options.name, 'NX', 'EX', this.options.masterLockTimeout)
    if (lockedByMe === true || lockedByMe === 1 || (lockedByMe && lockedByMe.toString().toLowerCase()) === 'ok') {
      return true
    }

    const currentMasterName = await this.connection.redis.get(masterKey)
    if (currentMasterName === this.options.name) {
      await this.connection.redis.expire(masterKey, this.options.masterLockTimeout)
      return true
    }

    return false
  }

  async releaseMasterLock () {
    if (!this.connection || !this.connection.redis) { return }

    const isMaster = await this.tryForMaster()
    if (!isMaster) { return false }

    const delted = await this.connection.redis.del(this.masterKey())
    this.master = false
    return (delted === 1 || delted === true)
  }

  async nextDelayedTimestamp () {
    const time = Math.round(new Date().getTime() / 1000)
    const items = await this.connection.redis.zrangebyscore(
      this.connection.key('delayed_queue_schedule'),
      '-inf',
      time,
      'limit',
      0,
      1
    )
    if (items.length === 0) { return }
    return items[0]
  }

  async enqueueDelayedItemsForTimestamp (timestamp) {
    const job = await this.nextItemForTimestamp(timestamp)
    if (job) {
      await this.transfer(timestamp, job)
      await this.enqueueDelayedItemsForTimestamp(timestamp)
    } else {
      await this.cleanupTimestamp(timestamp)
    }
  }

  async nextItemForTimestamp (timestamp) {
    const key = this.connection.key('delayed:' + timestamp)
    const job = await this.connection.redis.lpop(key)
    await this.connection.redis.srem(this.connection.key('timestamps:' + job), ('delayed:' + timestamp))
    return JSON.parse(job)
  }

  async transfer (timestamp, job) {
    await this.queue.enqueue(job.queue, job.class, job.args)
    this.emit('transferredJob', timestamp, job)
  }

  async cleanupTimestamp (timestamp) {
    const key = this.connection.key('delayed:' + timestamp)
    const length = await this.connection.redis.llen(key)
    if (length === 0) {
      await this.connection.redis.del(key)
      await this.connection.redis.zrem(this.connection.key('delayed_queue_schedule'), timestamp)
    }
  }

  async checkStuckWorkers () {
    if (!this.options.stuckWorkerTimeout) { return }

    const keys = await this.connection.getKeys(this.connection.key('worker', 'ping', '*'))
    const payloads = await Promise.all(keys.map(async (k) => {
      return JSON.parse(await this.connection.redis.get(k))
    }))

    const nowInSeconds = Math.round(new Date().getTime() / 1000)
    const stuckWorkerTimeoutInSeconds = Math.round(this.options.stuckWorkerTimeout / 1000)
    for (let i in payloads) {
      if (!payloads[i]) continue
      const { name, time } = payloads[i]
      const delta = nowInSeconds - time
      if (delta > stuckWorkerTimeoutInSeconds) {
        await this.forceCleanWorker(name, delta)
      }
      i++
    }
  }

  async forceCleanWorker (workerName, delta) {
    const errorPayload = await this.queue.forceCleanWorker(workerName)
    this.emit('cleanStuckWorker', workerName, errorPayload, delta)
  }
}

exports.Scheduler = Scheduler
