'use strict'

const crypto = require('crypto')
const bech32 = require('bech32')
const secp256k1 = require('secp256k1')
const Buffer = require('safe-buffer').Buffer
const BigNumber = require('bignumber.js')

const MULTIPLIERS = {
  m: BigNumber('0.001'),
  u: BigNumber('0.000001'),
  n: BigNumber('0.000000001'),
  p: BigNumber('0.000000000001')
}

const TAGNAMES = {
  '1': 'payment_hash',
  '13': 'description',
  '19': 'payee_node_key',
  '23': 'purpose_commit_hash', // commit to longer descriptions (like a website)
  '6': 'expire_time', // default: 3600 (1 hour)
  '24': 'min_final_cltv_expiry', // default: 9
  '9': 'fallback_address',
  '3': 'routing_info' // for extra routing info (private etc.)
}

const reduceWordsToIntBE = (total, item, index) => { return total + item * Math.pow(32, index) }

const wordsToIntBE = (words) => words.reverse().reduce(reduceWordsToIntBE, 0)

const convert = (data, inBits, outBits, pad) => {
  let value = 0
  let bits = 0
  let maxV = (1 << outBits) - 1

  let result = []
  for (let i = 0; i < data.length; ++i) {
    value = (value << inBits) | data[i]
    bits += inBits

    while (bits >= outBits) {
      bits -= outBits
      result.push((value >> bits) & maxV)
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((value << (outBits - bits)) & maxV)
    }
  } else {
    if (bits >= inBits) throw new Error('Excess padding')
    if ((value << (outBits - bits)) & maxV) throw new Error('Non-zero padding')
  }

  return result
}

const wordsTrimmedToBuffer = (words) => {
  let buffer = Buffer.from(convert(words, 5, 8, true))
  if (words.length * 5 % 8 !== 0) {
    buffer = buffer.slice(0,-1)
  }
  return buffer
}

const fallbackAddressParser = (words) => {
  let version = words[0]
  words = words.slice(1)
  
  let addressHash = wordsTrimmedToBuffer(words)
  
  return {
    lnver: version,
    addressHash: addressHash.toString('hex')
  }
}

const routingInfoParser = (words) => {
  let routes = []
  let pubkey, short_channel_id, fee_mSats, cltv_expiry_delta
  let routesBuffer = wordsTrimmedToBuffer(words)
  while (routesBuffer.length > 0) {
    pubkey = routesBuffer.slice(0,33).toString('hex') // 33 bytes
    short_channel_id = routesBuffer.slice(33,41).toString('hex') // 8 bytes
    fee_mSats = parseInt(routesBuffer.slice(41,49).toString('hex'),16) // 8 bytes
    cltv_expiry_delta = parseInt(routesBuffer.slice(49,51).toString('hex'),16) // 2 bytes

    routesBuffer = routesBuffer.slice(51)
    
    routes.push({
      pubkey,
      short_channel_id,
      fee_mSats,
      cltv_expiry_delta
    })
  }
  return routes
}

const TAGPARSERS = {
  '1': ((words) => wordsTrimmedToBuffer(words).toString('hex')), // 256 bits
  '13': ((words) => wordsTrimmedToBuffer(words).toString('utf8')), // string variable length
  '19': ((words) => wordsTrimmedToBuffer(words).toString('hex')), // 264 bits
  '23': ((words) => wordsTrimmedToBuffer(words).toString('hex')), // 256 bits
  '6': wordsToIntBE, // default: 3600 (1 hour)
  '24': wordsToIntBE, // default: 9
  '9': fallbackAddressParser,
  '3': routingInfoParser // for extra routing info (private etc.)
}

function encode (dataObj) {
  
}

function decode (paymentRequest) {
  if (paymentRequest.slice(0,2) !== 'ln') throw new Error('Not a proper lightning payment request')
  let { prefix, words } = bech32.decode(paymentRequest, 1023)
  
  let wordsCopy = words.slice(0)
  
  let coinType = prefix.slice(2,4)
  switch (coinType) {
    case 'bc':
      coinType = 'bitcoin'
      break
    case 'tb':
      coinType = 'tbitcoin'
      break
  }
  
  let value = prefix.slice(4)
  let satoshis
  if (value) {
    let valueInt
    let multiplier = value.slice(-1).match(/[munp]/) ? value.slice(-1) : null
    if (multiplier) {
      valueInt = parseInt(value.slice(0,-1))
    } else {
      valueInt = parseInt(value)
    }
    satoshis = multiplier ? MULTIPLIERS[multiplier].mul(valueInt).mul(1e8).toNumber() : valueInt * 1e8
  } else {
    satoshis = null
  }
  
  let timestamp = wordsToIntBE(words.slice(0,7))
  let timestampString = new Date(timestamp * 1000).toISOString()
  words = words.slice(7)
  
  let sigWords = words.slice(-104)
  words = words.slice(0,-104)
  
  let tags = {}
  let tagName, parser, tagLength, tagWords, tag
  while (words.length > 0) {
    tagName = TAGNAMES[words[0].toString()]
    parser = TAGPARSERS[words[0].toString()]
    words = words.slice(1)
    
    tagLength = wordsToIntBE(words.slice(0,2))
    words = words.slice(2)
    
    tagWords = words.slice(0,tagLength)
    words = words.slice(tagLength)
    
    tags[tagName] = parser(tagWords)
  }
  
  let expireDate, expireDateString
  if (tags.expire_time) {
    expireDate = timestamp + tags.expire_time
    expireDateString = new Date(expireDate * 1000).toISOString()
  }
  
  let sigBuffer = wordsTrimmedToBuffer(sigWords)
  let recoveryFlag = sigBuffer.slice(-1)[0]
  sigBuffer = sigBuffer.slice(0,-1)
  
  let toSign = Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(convert(wordsCopy, 5, 8, true))])
  let payReqHash = crypto.createHash('sha256').update(toSign).digest()
  let sigPubkey = secp256k1.recover(payReqHash, sigBuffer, recoveryFlag, true)
  if (!secp256k1.verify(payReqHash, sigBuffer, sigPubkey)) {
    throw new Error('Lightning Payment Request signature is not valid.')
  }
  if (tags.payee_node_key && tags.payee_node_key !== sigPubkey.toString('hex')) {
    throw new Error('Lightning Payment Request signature pubkey does not match payee pubkey')
  }
  
  return Object.assign({
    coinType,
    satoshis,
    timestamp,
    timestampString,
    payee_node_key: sigPubkey.toString('hex'),
    tags
  }, (expireDate ? {expireDate} : {}), (expireDateString ? {expireDateString} : {}))
}


module.exports = {
  encode,
  decode
}
