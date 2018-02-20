import axios from 'axios'
const {accountPair} = require('./util/util.js')

import {API, SendBlock, ReceiveBlock, OpenBlock, ChangeBlock} from './api'

export type RPCClient = (params: any) => Promise<any>
function createAPI<API extends {[action: string]: any} = any>(
  rpcClient: RPCClient
) {
  return async function callRPC<Action extends keyof API>(
    action: Action,
    body: API[Action]['body']
  ): Promise<API[Action]['response']> {
    const params = Object.assign({}, body, {action})
    return rpcClient(params)
  }
}

export function createAxiosClient(
  apiKey: string,
  baseURL = 'https://api.nanode.co/'
): RPCClient {
  const rpc = axios.create({
    baseURL,
    headers: {
      Authorization: apiKey
    }
  })

  return async function(params: any): Promise<any> {
    const {data} = await rpc.post('/', params)
    return data
  }
}

export interface NanoConstructorOptions {
  apiKey?: string
  url?: string
  rpcClient?: RPCClient
  debug?: boolean
}

export default class Nano {
  rpc = createAPI<API>(null)
  debug: boolean

  constructor(options: NanoConstructorOptions) {
    this.debug = !!options.debug
    if (options.rpcClient) {
      this.rpc = createAPI<API>(options.rpcClient)
    } else {
      const rpcClient = createAxiosClient(options.apiKey, options.url)
      this.rpc = createAPI<API>(rpcClient)
    }

    this.log = this.log.bind(this)
  }

  log(message: string) {
    if (this.debug) {
      console.log(message)
    }
  }

  account(private_key: string) {
    const {address} = accountPair(private_key)

    return {
      open: (respresentative?: string, hash?: string) => {
        return this.open(private_key, respresentative, hash)
      },
      send: (amount: string, address: string) => {
        return this.send(private_key, amount, address)
      },
      receive: (hash?: string) => {
        return this.receive(private_key, hash)
      },
      change: (representative: string) => {
        return this.change(private_key, representative)
      },
      balance: () => {
        return this.accounts.balance(address)
      },
      blockCount: () => {
        return this.accounts.block_count(address)
      },
      history: (count?: number) => {
        return this.accounts.history(address, count)
      },
      info: () => {
        return this.accounts.info(address)
      },
      publicKey: () => {
        return this.accounts.key(address)
      },
      ledger: (count?: number, details?: boolean) => {
        return this.accounts.ledger(address, count, details)
      },
      pending: (count?: number, threshold?: string) => {
        return this.accounts.pending(address, count, threshold)
      },
      representative: () => {
        return this.accounts.representative(address)
      },
      weight: () => {
        return this.accounts.weight(address)
      }
    }
  }

  //Top-level call: open block
  async open(
    private_key: string,
    representative?: string,
    send_block_hash?: string
  ) {
    const {log} = this

    if (!private_key) {
      throw new Error('Must pass private_key argument')
    }

    if (!representative) {
      representative =
        'xrb_1nanode8ngaakzbck8smq6ru9bethqwyehomf79sae1k7xd47dkidjqzffeg'
    }

    const {address, publicKey} = accountPair(private_key)
    const {work} = await this.work.generate(publicKey)

    if (!send_block_hash) {
      const res = await this.accounts.pending(address, 1)
      if (!res.blocks || res.blocks.length === 0) {
        throw new Error('This account has no pending blocks to receive')
      }

      send_block_hash = res.blocks[0]
    }

    const block = await this.blocks.createOpen({
      previous: publicKey,
      key: private_key,
      source: send_block_hash,
      work,
      representative
    })

    const result = await this.blocks.publish(block.block)
    log(
      `Opened NANO account ${address} with block ${
        result.hash
      } and representative ${representative}!`
    )
    return result
  }

  //Top-level call: send block
  async send(
    private_key: string,
    amount: string,
    recipient_wallet_address: string
  ) {
    const {log} = this

    if (!private_key) {
      throw new Error('Must pass private_key argument')
    }

    const {balance, frontier, work} = await this.generateLatestWork(private_key)
    const rai_to_send = await this.convert.toRaw(+amount * 1000, 'krai')

    const block = await this.blocks.createSend({
      key: private_key,
      // account: address,
      destination: recipient_wallet_address,
      balance,
      amount: rai_to_send.amount,
      previous: frontier,
      work
    })

    const result = await this.blocks.publish(block.block)
    log(`Sent ${rai_to_send} NANO to ${recipient_wallet_address}!`)
    return result.hash
  }

  //Top-level call: receive block
  async receive(private_key: string, send_block_hash?: string) {
    const {log} = this

    if (!private_key) {
      throw new Error('Must pass private_key argument')
    }

    const {address, frontier, work} = await this.generateLatestWork(private_key)

    if (!send_block_hash) {
      const res = await this.accounts.pending(address, 1)
      if (!res.blocks || res.blocks.length === 0) {
        throw new Error('This account has no pending blocks to receive')
      }

      send_block_hash = res.blocks[0]
    }

    const block = await this.blocks.createReceive({
      key: private_key,
      previous: frontier,
      work,
      source: send_block_hash
    })

    const result = await this.blocks.publish(block.block)
    log(`Received block ${send_block_hash} to wallet ${address}!`)
    return result
  }

  //Top-level call: change block
  async change(private_key: string, representative: string) {
    const {log} = this

    if (!private_key) {
      throw new Error('Must pass private_key argument')
    }

    const {frontier, work} = await this.generateLatestWork(private_key)

    const block = await this.blocks.createChange({
      previous: frontier,
      representative,
      work,
      key: private_key
    })

    const result = await this.blocks.publish(block.block)
    log(`Opened NANO block ${result.hash} with rep. ${representative}!`)
    return result
  }

  async generateLatestWork(private_key: string) {
    const {address} = accountPair(private_key)
    const {balance, frontier} = await this.accounts.info(address)
    const {work} = await this.work.generate(frontier)

    return {
      address,
      balance,
      frontier,
      work
    }
  }

  //General account methods
  get accounts() {
    const {rpc, log} = this
    return {
      async get(publicKey: string) {
        if (!publicKey) {
          throw new Error(`Must supply publicKey argument`)
        }
        return rpc('account_get', {key: publicKey})
      },
      async balance(account: string) {
        if (!account) {
          throw new Error(`Must supply account address argument`)
        }
        return rpc('account_balance', {account})
      },
      async balances(accounts: string[]) {
        return rpc('accounts_balances', {
          accounts
        })
      },
      async block_count(account: string) {
        if (!account) {
          throw new Error(`Must supply account address argument`)
        }
        return rpc('account_block_count', {
          account
        })
      },
      async frontiers(accounts: string[]) {
        return rpc('accounts_frontiers', {
          accounts
        })
      },
      async history(account: string, count?: number) {
        if (!account) {
          throw new Error(`Must supply account address argument`)
        }
        return rpc('account_history', {
          account,
          count: count || 1000
        }).then(res => res.data)
      },
      async info(account: string) {
        if (!account) {
          throw new Error(`Must supply account address argument`)
        }
        return rpc('account_info', {account}).then(account => {
          log(`(ACCOUNT) balance: ${account.balance}`)
          log(`(ACCOUNT) latest hash: ${account.frontier}`)
          return account
        })
      },
      async key(account: string) {
        return rpc('account_key', {account})
      },
      async ledger(account: string, count?: number, details?: boolean) {
        if (!account) {
          throw new Error(`Must supply account address argument`)
        }
        return rpc('ledger', {
          account,
          count: count || 1000,
          representative: details,
          weight: details,
          pending: details
        })
      },
      async pending(account: string, count?: number, threshold?: string) {
        // TODO: convert threshold from xrb to raw
        return rpc('pending', {
          account,
          threshold,
          count: count || 1000
        })
      },
      async pendingMulti(
        accounts: string[],
        count?: number,
        threshold?: string
      ) {
        // TODO: convert threshold from xrb to raw
        return rpc('accounts_pending', {
          accounts,
          threshold,
          count: count || 1000
        })
      },
      async representative(account: string) {
        return rpc('account_representative', {
          account
        }).then(res => res.representative)
      },
      async weight(account: string) {
        return rpc('account_weight', {account}).then(res => res.weight)
      }
    }
  }

  //General block related calls
  get blocks() {
    const {rpc, log} = this

    return {
      async account(hash: string) {
        return rpc('block_account', {hash}).then(res => {
          return res.account
        })
      },
      async count(by_type?: boolean) {
        return by_type ? rpc('block_count_type', {}) : rpc('block_count', {})
      },
      async chain(block: string, count?: number) {
        return rpc('chain', {
          block,
          count: count || 1000
        }).then(res => res.blocks)
      },
      async createChange(block: ChangeBlock) {
        return rpc('block_create', {
          type: 'change',
          ...block
        }).then(res => {
          log(`(BLOCK) Changing ${block.key}`)
          return res
        })
      },
      async history(hash: string, count?: number) {
        return rpc('history', {
          hash,
          count: count || 1000
        })
      },
      //Get one or many block's information
      async info(hashOrHashes: string | string[], details?: boolean) {
        const getMulti = (typeof hashOrHashes as string | string[]) === 'array'
        if (getMulti) {
          return details
            ? rpc('blocks_info', {
                hashes: hashOrHashes as string[]
              }).then(res => res.blocks)
            : rpc('blocks', {
                hashes: hashOrHashes as string[]
              }).then(res => res.blocks)
        } else {
          return rpc('block', {
            hash: hashOrHashes as string
          }).then(res => res.contents)
        }
      },
      async createOpen(block: OpenBlock) {
        return rpc('block_create', {
          type: 'open',
          ...block
        }).then(res => {
          log(`(BLOCK) Opening ${block.key}`)
          return res
        })
      },
      async pending(hash: string) {
        return rpc('pending_exists', {hash}).then(res => res.exists === '1')
      },
      async publish(block: string) {
        return rpc('process', {block: block}).then(res => {
          log(`(BLOCK) Published: ${res.hash}`)
          return res
        })
      },
      async createReceive(block: ReceiveBlock) {
        return rpc('block_create', {
          type: 'receive',
          ...block
        }).then(res => {
          log(`Received block ${block.source}`)
          return res
        })
      },
      async createSend(block: SendBlock) {
        return rpc('block_create', {
          type: 'send',
          ...block
        }).then(res => {
          log(`(BLOCK) Sending ${block.amount} to ${block.destination}`)
          return res
        })
      },
      async successors(block: string, count?: number) {
        return rpc('successors', {
          block,
          count: count || 1000
        })
      }
    }
  }

  //Convert KRAI, MRAI, RAI to and from RAW
  get convert() {
    const {rpc} = this
    type Denomination = 'rai' | 'krai' | 'mrai'
    return {
      async toRaw(amount: number, denomination: Denomination) {
        if (!amount) {
          throw new Error('Must pass amount to conversion call')
        }
        return rpc(`${denomination}_to_raw` as any, {
          amount: amount.toString()
        })
      },
      async fromRaw(amount: number, denomination: Denomination) {
        if (!amount) {
          throw new Error('Must pass amount to conversion call')
        }
        return rpc(`${denomination}_from_raw` as any, {
          amount: amount.toString()
        })
      }
    }
  }

  //get, count delegators
  //TODO: could be a single method
  get delegators() {
    const {rpc} = this
    return {
      async get(account: string) {
        return rpc('delegators', {account}).then(res => res)
      },
      async count(account: string) {
        return rpc('delegators_count', {account}).then(res => res.count)
      }
    }
  }

  //Get, count frontiers
  //TODO: could be a single method
  get frontiers() {
    const {rpc} = this
    return {
      async get(account: string, count?: number) {
        return rpc('frontiers', {
          account,
          count: count || 1000
        })
      },
      async count(account: string) {
        return rpc('frontier_count', {account}).then(res => res.count)
      }
    }
  }

  //Create and expand keys
  get key() {
    const {rpc, log} = this
    return {
      async create() {
        return rpc('key_create', {}).then(res => {
          log(`Created key ${res}`)
          return res
        })
      },
      async expand(privateKey: string) {
        return rpc('key_expand', {key: privateKey})
      }
    }
  }

  //Generate and get work
  get work() {
    const {rpc, log} = this

    return {
      async generate(hash: string) {
        return rpc('work_generate', {hash}).then(result => {
          log(`(WORK) generated PoW: ${result.work}`)
          return result
        })
      },
      async validate(work: string, hash: string) {
        return rpc('work_validate', {work, hash})
      }
    }
  }

  async available() {
    return this.rpc('available_supply', {}).then(res => res.available)
  }
  async representatives() {
    return this.rpc('representatives', {}).then(res => res.representatives)
  }

  async deterministicKey(seed: string, index?: number) {
    return this.rpc('deterministic_key', {
      seed,
      index: '0'
    })
  }

  get minimumReceive() {
    const {rpc} = this
    return {
      async get() {
        return rpc('receive_minimum', {})
      },
      async set(amount: string) {
        return rpc('receive_minimum_set', {
          amount
        }).then(res => res.success === '')
      }
    }
  }
}
