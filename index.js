const WebSocket = require('ws')
const defaults = require('deep-defaults')
const EventEmitter = require('events').EventEmitter
const bs = require('binarysearch')

class DistriServer extends EventEmitter {
  constructor (opts) {
    super()
    if (opts.constructor.name !== 'Object') throw new TypeError('Options must be given in the form of an object')

    const priorities = ['node', 'javascript']

    // explained in the README
    this.options = defaults(opts, {
      connection: {
        port: 8080
      },

      verificationStrength: 1,

      files: {

      }

    })

    const order = priorities.filter(priority => this.options.files[priority])

    this.server = new WebSocket.Server(this.options.connection)

    // the number of the solved problems
    this.solutions = 0

    // the number of currently pending problems
    // how many connected users there are
    this.userCount = 0

    // A queue of websocket client objects if the
    // user count is not met.
    this.userQueue = []
    this.session = []
        // where the work is stored, along with all its metadata

    this.remaining = []

    const randomIndGenerator = () => {
      let index

      if (this.session.length === 0 || this.pending + this.solutions > this.session.length) return -1
      // get a random index from the session array.
      index = this.remaining[(Math.random() * this.remaining.length) | 0]
      // if everything is full
      if (this.remaining.length === 0) {
        return -1
      } else {
        return index
      }
    }

    this.server.on('connection', (ws) => {
      // Generate a starting index in the session array. Starting at -1
      // will let the server know if someone unverified is trying to
      // request work
      let sentFile = false
      let ind = -1
      // generate something random for later on
      this.userCount++

      ws.on('message', (m) => {
        let message

        try {
          message = JSON.parse(m)
        } catch (e) {
          return
        }
        const workGetter = () => {
          ind = randomIndGenerator()
          if (ind === -1) {
            ws.send(JSON.stringify({error: 'No work available'}))
          } else {
            this.session[ind].workers++
            ws.send(JSON.stringify({responseType: 'submit_work', work: this.session[ind].work}))
            if (this.session[ind].workers + this.session[ind].solutionCount === this.options.verificationStrength && bs(this.remaining, ind) !== -1) {
              this.remaining.splice(bs(this.remaining, ind), 1)
            }
          }
        }

        // if anything is wrong with the message
        if ((message.constructor !== Object) || message.response === undefined || !message.responseType) {
          // kick the user if the server is using strict mode
          return
        }
        if (message.responseType === 'request') {
          if (sentFile === false) {
            let avail

            try {
              avail = message.response.reduce((pre, cur) => order.indexOf(cur) < order.indexOf(pre) ? cur : pre)
            } catch (e) {
              return
            }

            if (order.indexOf(avail) === -1) {
              ws.send(JSON.stringify({error: 'No work available for supported settings'}))
              ws.close()
              return
            }
            ws.send(JSON.stringify({responseType: 'file', response: [this.options.files[avail], avail]}))
          }
        } else if (message.responseType === 'request_work') {
          workGetter()
        } else if (message.responseType === 'submit_work') {
          if (message.response === undefined) {
            return
          }

          const index = ind

          ind = -1
          new Promise((resolve, reject) => {
            if (this.listenerCount('work_submitted') === 0) {
              resolve()
            } else {
              this.emit('work_submitted', this.session[index].work, message.response, ws, resolve, reject)
            }
          })
          .then(() => {
            this.session[index].solutions.push(message.response)

            this.session[index].solutionCount++

            this.session[index].workers--
            workGetter()
            if (this.session[index].solutionCount === this.options.verificationStrength) {
              this.pending++
              new Promise((resolve, reject) => {
                if (this.listenerCount('workgroup_complete') === 0) {
                  resolve()
                } else {
                  this.emit('workgroup_complete', this.session[index].work, this.session[index].solutions, resolve, reject)
                }
              })
                .then(answer => {
                  this.pending--
                  this.emit('workgroup_accepted', this.session[index].work, answer)
                  if (bs(this.remaining, index) !== -1) this.remaining.splice(bs(this.remaining, index), 1)
                  this.solutions++
                  if (this.solutions === this.session.length) {
                    this.session = []
                    this.emit('all_work_complete')
                    this.solutions = 0
                  }
                })
                .catch(() => {
                  this.pending--
                  this.emit('workgroup_rejected', this.session[index].work, this.session[index].solutions)
                  this.session[index].solutions = []
                  this.session[index].workers = 0
                  this.session[index].solutionCount = 0
                  if (bs(this.remaining, index) === -1) {
                    bs.insert(this.remaining, index)
                  }
                })
            }
          })
          .catch(() => {
            // just ignore it, whatever
            this.workers--
          })
        }
      })

      ws.on('close', () => {
        this.userCount--
        if (ind !== -1) {
          this.session[ind].workers--
        }
      })
    })
  }

  addWork (work) {
    let emitReady = false
    if (this.session.length === 0) emitReady = true
    if (work.constructor.name !== 'Array') throw new TypeError('Added work must be in the form of an array')

    work.map(work => {
      this.remaining.push(this.session.push({work, solutions: [], workers: 0, solutionCount: 0}) - 1)
    })
    this.remaining.sort((a, b) => {
      if (a > b) {
        return 1
      } else {
        return -1
      }
    })
    console.log(this.session)
    if (emitReady) this.server.clients.map(client => client.send(JSON.stringify({responseType: 'request'})))
  }

  CheckPercentage (solutions, percentage, resolve, reject) {
    const init = solutions[0]
    if (solutions.every(solution => solution === init)) {
      resolve(init)
    } else {
      const check = new Map()
      solutions.map(solution => check.has(solution) ? check.set(solution, check.get(solution) + 1) : check.set(solution, 1))
      let greatest = {solution: null, hits: 0}
      for (let [key, val] of check) {
        if (val > greatest.hits) greatest = {solution: key, hits: val}
      }

      if ((greatest.hits / this.options.verificationStrength) >= (percentage / 100)) {
        resolve(greatest.solution)
      } else {
        reject()
      }
    }
  }
}

module.exports.DistriServer = DistriServer

class DistriClient {
  constructor (opts) {
    const onDeath = require('death')

    if (opts.constructor.name !== 'Object') throw new TypeError('Options must be in the form of an object')
    const spawn = require('child_process').spawn
    const request = require('request')
    const fs = require('fs')
    this.options = defaults(opts, {
      host: 'ws://localhost:8081',
      availableMethods: ['node']
    })

    this.client = new WebSocket(this.options.host)
    const submit = (work) => {
      this.client.send(JSON.stringify({
        responseType: 'submit_work',
        response: work,
        login
      }))
    }

    const file = fs.createWriteStream(`./distri-file`)
    let runner

    onDeath((sig, err) => {
      if (runner) runner.kill('SIGINT')
      fs.unlinkSync(`./distri-file`)
    })

    let login

    this.client.on('open', () => {
      this.client.send(JSON.stringify({responseType: 'request', response: ['node']}))
    })
    this.client.on('message', (m) => {
      const message = JSON.parse(m)
      switch (message.responseType) {
        case 'file':
          request(message.response[0]).pipe(file).on('close', () => {
            runner = spawn(message.response[1], [`./distri-file`], {stdio: ['pipe', 'pipe', 'pipe']})
            runner.stdout.on('data', (data) => {
              if (data.toString() === 'ready') {
                this.client.send(JSON.stringify({response: true, responseType: 'request_work'}))
              } else {
                submit(JSON.parse(data).data)
              }
            })
          })
          break
        case 'submit_work':
          runner.stdin.write(JSON.stringify({data: message.work}))
          break
      }
    })
  }
}

module.exports.DistriClient = DistriClient
