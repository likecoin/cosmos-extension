/* eslint-disable @typescript-eslint/no-explicit-any */
import { AminoSignResponse, OfflineAminoSigner, StdSignature, StdSignDoc } from '@cosmjs/amino'
import { DirectSignResponse, OfflineDirectSigner } from '@cosmjs/proto-signing'
import {
  convertObjectCasingFromCamelToSnake,
  MsgConverter,
  UnknownMessage,
} from '@leapwallet/buffer-boba'
import {
  GasOptions,
  LeapWalletApi,
  useActiveWallet,
  useChainInfo,
  useDefaultGasEstimates,
  useSelectedNetwork,
  useSetSelectedNetwork,
  WALLETTYPE,
} from '@leapwallet/cosmos-wallet-hooks'
import {
  chainIdToChain,
  ChainInfos,
  ethSign,
  GasPrice,
  LedgerError,
  SupportedChain,
  transactionDeclinedError,
} from '@leapwallet/cosmos-wallet-sdk'
import { EthWallet } from '@leapwallet/leap-keychain'
import { Avatar, Buttons, Header } from '@leapwallet/leap-ui'
import {
  MessageParser,
  parfait,
  ParsedMessage,
  ParsedMessageType,
} from '@leapwallet/parser-parfait'
import { captureException } from '@sentry/react'
import classNames from 'classnames'
import Tooltip from 'components/better-tooltip'
import { ErrorCard } from 'components/ErrorCard'
import GasPriceOptions, { useDefaultGasPrice } from 'components/gas-price-options'
import { useGasPriceContext } from 'components/gas-price-options/context'
import PopupLayout from 'components/layout/popup-layout'
import LedgerConfirmationModal from 'components/ledger-confirmation/confirmation-modal'
import { LoaderAnimation } from 'components/loader/Loader'
import SelectWalletSheet from 'components/select-wallet-sheet'
import { Tabs } from 'components/tabs'
import Text from 'components/text'
import { walletLabels } from 'config/constants'
import { BG_RESPONSE, SIGN_REQUEST } from 'config/storage-keys'
import { SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx'
import { decodeChainIdToChain } from 'extension-scripts/utils'
import { useActiveChain, useSetActiveChain } from 'hooks/settings/useActiveChain'
import { useChainInfos } from 'hooks/useChainInfos'
import { useSiteLogo } from 'hooks/utility/useSiteLogo'
import { Wallet } from 'hooks/wallet/useWallet'
import { Images } from 'images'
import { GenericLight } from 'images/logos'
import { AminoTypes } from 'osmojs/node_modules/@cosmjs/stargate'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Colors } from 'theme/colors'
import { assert } from 'utils/assert'
import { DEBUG } from 'utils/debug'
import { imgOnError } from 'utils/imgOnError'
import { trim } from 'utils/strings'
import { uint8ArrayToBase64 } from 'utils/uint8Utils'
import browser from 'webextension-polyfill'

import { isCompassWallet } from '../../utils/isCompassWallet'
import { MemoInput } from './memo-input'
import MessageDetailsSheet from './message-details-sheet'
import MessageList from './message-list'
import StaticFeeDisplay from './static-fee-display'
import TransactionDetails from './transaction-details'
import { isGenericOrSendAuthzGrant } from './utils/is-generic-or-send-authz-grant'
import { getAminoSignDoc } from './utils/sign-amino'
import { getDirectSignDoc, getProtoSignDocDecoder } from './utils/sign-direct'
import { logDirectTx, logSignAmino } from './utils/tx-logger'

const useGetWallet = Wallet.useGetWallet

const messageParser = new MessageParser()

type SignTransactionProps = {
  data: Record<string, any>
  chainId: string
  isSignArbitrary: boolean
}

const SignTransaction = ({
  data: txnSigningRequest,
  chainId,
  isSignArbitrary,
}: SignTransactionProps) => {
  const [showWalletSelector, setShowWalletSelector] = useState(false)
  const [showMessageDetailsSheet, setShowMessageDetailsSheet] = useState(false)
  const [selectedMessage, setSelectedMessage] = useState<{
    index: number
    parsed: ParsedMessage
    raw: null
  } | null>(null)
  const [showLedgerPopup, setShowLedgerPopup] = useState(false)
  const [ledgerError, setLedgerError] = useState<string>()
  const [signingError, setSigningError] = useState<string | null>(null)
  const [gasPriceError, setGasPriceError] = useState<string | null>(null)
  const [userPreferredGasLimit, setUserPreferredGasLimit] = useState<string>('')
  const [userMemo, setUserMemo] = useState<string>('')

  const [checkedGrantAuthBox, setCheckedGrantAuthBox] = useState(false)
  const chainInfo = useChainInfo()
  const chainInfos = useChainInfos()
  const activeWallet = useActiveWallet()
  const getWallet = useGetWallet()
  const defaultGasPrice = useDefaultGasPrice()
  const activeChain = useActiveChain()
  const txPostToDb = LeapWalletApi.useLogCosmosDappTx()
  const defaultGasEstimates = useDefaultGasEstimates()
  const selectedGasOptionRef = useRef(false)

  const [gasPriceOption, setGasPriceOption] = useState<{
    option: GasOptions
    gasPrice: GasPrice
  }>({ gasPrice: defaultGasPrice.gasPrice, option: GasOptions.LOW })

  assert(activeWallet !== null, 'activeWallet is null')

  const walletName = useMemo(() => {
    return activeWallet.walletType === WALLETTYPE.LEDGER
      ? `${walletLabels[activeWallet.walletType]} Wallet ${activeWallet.addressIndex + 1}`
      : activeWallet.name
  }, [activeWallet.addressIndex, activeWallet.name, activeWallet.walletType])

  const handleCancel = useCallback(async () => {
    await browser.storage.local.set({
      [BG_RESPONSE]: { error: 'Transaction cancelled by the user.' },
    })
    setTimeout(async () => {
      await browser.storage.local.remove(SIGN_REQUEST)
      await browser.storage.local.remove(BG_RESPONSE)
      window.close()
    }, 10)
  }, [])

  useEffect(() => {
    setGasPriceOption({
      gasPrice: defaultGasPrice.gasPrice,
      option: GasOptions.LOW,
    })
  }, [defaultGasPrice])

  const { isAmino, isAdr36, ethSignType, signOptions } = useMemo(() => {
    const isAmino = !!txnSigningRequest?.isAmino
    const isAdr36 = !!txnSigningRequest?.isAdr36
    const ethSignType = txnSigningRequest?.ethSignType
    const signOptions = txnSigningRequest?.signOptions
    return { isAmino, isAdr36, ethSignType, signOptions }
  }, [txnSigningRequest])

  const [allowSetFee, messages, txnDoc, signDoc, fee, defaultFee, defaultMemo]: [
    boolean,
    (
      | {
          parsed: ParsedMessage
          raw: any
        }[]
      | null
    ),
    any,
    SignDoc | StdSignDoc,
    any,
    any,
    string,
  ] = useMemo(() => {
    if (isAmino) {
      const result = getAminoSignDoc({
        signRequestData: {
          'sign-request': txnSigningRequest,
        },
        gasPrice: gasPriceOption.gasPrice,
        gasLimit: userPreferredGasLimit,
        isAdr36: !!isAdr36,
        memo: userMemo,
        isGasOptionSelected: selectedGasOptionRef.current,
      })

      let parsedMessages

      if (isSignArbitrary) {
        parsedMessages = Buffer.from(result.signDoc.msgs[0].value.data, 'base64').toString('utf-8')
      } else if (ethSignType) {
        parsedMessages = [
          {
            raw: result.signDoc.msgs,
            parsed: {
              __type: 'sign/MsgSignData',
              message: result.signDoc.msgs[0].value.data,
            },
          },
        ]
      } else {
        parsedMessages = result.signDoc.msgs.map((msg: any) => {
          let convertedMessage
          try {
            convertedMessage = MsgConverter.convertFromAminoToDirect(msg.type, msg)
            if (!convertedMessage) throw new Error('unable to convert amino message to direct')
            return {
              raw: msg,
              parsed: messageParser.parse({
                '@type': convertedMessage.typeUrl,
                ...msg.value,
              }),
            }
          } catch (e) {
            return {
              raw: msg,
              parsed: {
                __type: ParsedMessageType.Unimplemented,
                message: msg,
              } as parfait.unimplemented,
            }
          }
        })
      }

      return [
        result.allowSetFee,
        parsedMessages,
        result.signDoc,
        result.signDoc,
        result.fee,
        result.defaultFee,
        result.defaultMemo,
      ]
    } else {
      const result = getDirectSignDoc({
        signRequestData: {
          'sign-request': txnSigningRequest,
        },
        gasPrice: gasPriceOption.gasPrice,
        gasLimit: userPreferredGasLimit,
        memo: userMemo,
        isGasOptionSelected: selectedGasOptionRef.current,
      })

      const docDecoder = getProtoSignDocDecoder({
        'sign-request': txnSigningRequest,
      })

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const parsedMessages = docDecoder.txMsgs.map((msg: { unpacked: any; typeUrl: string }) => {
        if (msg instanceof UnknownMessage) {
          const raw = msg.toJSON()
          return {
            raw: raw,
            parsed: {
              __type: ParsedMessageType.Unimplemented,
              message: {
                '@type': raw.type_url,
                body: raw.value,
              },
            } as parfait.unimplemented,
          }
        }

        if (msg.unpacked.msg instanceof Uint8Array) {
          const base64String = uint8ArrayToBase64(msg.unpacked.msg)
          const decodedString = Buffer.from(base64String, 'base64').toString()
          try {
            const decodedJson = JSON.parse(decodedString)
            msg.unpacked.msg = decodedJson
          } catch {
            msg.unpacked.msg = decodedString
          }
        }

        const convertedMsg = convertObjectCasingFromCamelToSnake(
          (msg as unknown as { unpacked: any }).unpacked,
        )

        return {
          raw: {
            '@type': msg.typeUrl,
            ...convertedMsg,
          },
          parsed: messageParser.parse({
            '@type': msg.typeUrl,
            ...convertedMsg,
          }),
        }
      })

      return [
        result.allowSetFee,
        parsedMessages,
        docDecoder.toJSON(),
        result.signDoc,
        result.fee,
        result.defaultFee,
        result.defaultMemo,
      ]
    }
  }, [
    isAmino,
    txnSigningRequest,
    gasPriceOption.gasPrice,
    userPreferredGasLimit,
    isAdr36,
    userMemo,
    isSignArbitrary,
    ethSignType,
  ])

  const siteOrigin = txnSigningRequest?.origin as string | undefined
  const siteName = siteOrigin?.split('//')?.at(-1)?.split('.')?.at(-2)
  const siteLogo = useSiteLogo(siteOrigin)

  const currentWalletInfo = useMemo(() => {
    if (!activeWallet || !chainId || !siteOrigin) return undefined
    return {
      wallets: [activeWallet] as [typeof activeWallet],
      chainIds: [chainId] as [string],
      origin: siteOrigin,
    }
  }, [activeWallet, chainId, siteOrigin])

  const recommendedGasLimit: string = useMemo(() => {
    if (defaultFee) {
      return 'gasLimit' in defaultFee ? defaultFee.gasLimit.toString() : defaultFee.gas.toString()
    }
    return defaultGasEstimates[activeChain].DEFAULT_GAS_IBC.toString()

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChain, defaultFee])

  const dappFeeDenom = useMemo(() => {
    if (defaultFee && defaultFee?.amount[0]) {
      const { denom } = defaultFee.amount[0]
      // calculate gas price based on recommended gas limit
      return denom
    }
    return defaultGasPrice.gasPrice.denom
  }, [defaultFee, defaultGasPrice.gasPrice])

  const approveTransaction = useCallback(async () => {
    const activeAddress = activeWallet.addresses[activeChain]
    if (!activeChain || !signDoc || !activeAddress) {
      return
    }
    if (!isAmino) {
      try {
        const wallet = (await getWallet(activeChain)) as OfflineDirectSigner
        const data = await (async () => {
          try {
            return wallet.signDirect(activeAddress, SignDoc.fromPartial(signDoc as any))
          } catch (e) {
            captureException(e)
            return null
          }
        })()

        if (!data) {
          throw new Error('Could not sign transaction')
        }

        const bgResponse = JSON.stringify(data)

        try {
          await browser.storage.local.set({ [BG_RESPONSE]: bgResponse })
        } catch {
          throw new Error('Could not send transaction to the dApp')
        }

        logDirectTx(
          data as DirectSignResponse,
          signDoc as SignDoc,
          siteOrigin ?? origin,
          fee,
          activeChain,
          activeWallet?.addresses[activeChain] as string,
          txPostToDb,
          txnDoc.chain_id,
        ).catch((e) => {
          DEBUG('logDirectTx error', e)
        })

        setTimeout(async () => {
          await browser.storage.local.remove(SIGN_REQUEST)
          window.close()
        }, 10)
      } catch (e) {
        if (e instanceof Error) {
          if (e.message === transactionDeclinedError.message) {
            handleCancel()
          } else {
            setSigningError(e.message)
          }
        }
      }
    } else {
      setSigningError(null)
      try {
        const wallet = (await getWallet(activeChain)) as OfflineAminoSigner & {
          signAmino: (
            // eslint-disable-next-line no-unused-vars
            address: string,
            // eslint-disable-next-line no-unused-vars
            signDoc: StdSignDoc,
            // eslint-disable-next-line no-unused-vars
            options?: { extraEntropy?: boolean },
          ) => Promise<StdSignature>
        }
        setShowLedgerPopup(true)
        const data = await (async () => {
          try {
            if (ethSignType) {
              return ethSign(
                activeAddress,
                wallet as unknown as EthWallet,
                signDoc as StdSignDoc,
                ethSignType,
              )
            }
            return wallet.signAmino(activeAddress, signDoc as StdSignDoc, {
              extraEntropy: !signOptions?.enableExtraEntropy
                ? false
                : signOptions?.enableExtraEntropy,
            })
          } catch (e) {
            captureException(e)
            return null
          }
        })()

        const walletAccounts = await wallet.getAccounts()
        try {
          await logSignAmino(
            data as AminoSignResponse,
            walletAccounts[0].pubkey,
            txPostToDb,
            activeChain,
            activeAddress,
            siteOrigin ?? origin,
          )
        } catch {
          //
        }

        if (!data) {
          throw new Error('Could not sign transaction')
        }

        const bgResponse = JSON.stringify(data)

        try {
          await browser.storage.local.set({ [BG_RESPONSE]: bgResponse })
        } catch {
          throw new Error('Could not send transaction to the dApp')
        }

        setTimeout(async () => {
          await browser.storage.local.remove(SIGN_REQUEST)
          window.close()
        }, 10)
      } catch (e) {
        if (e instanceof Error) {
          if (e instanceof LedgerError) {
            setLedgerError(e.message)
            e.message === transactionDeclinedError.message && handleCancel()
          } else {
            e.message === transactionDeclinedError.message
              ? handleCancel()
              : setSigningError(e.message)
          }
        }
      } finally {
        setShowLedgerPopup(false)
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeWallet.addresses,
    activeChain,
    signDoc,
    isAmino,
    getWallet,
    siteOrigin,
    fee,
    txPostToDb,
    handleCancel,
    ethSignType,
  ])

  useEffect(() => {
    window.addEventListener('beforeunload', handleCancel)
    browser.storage.local.remove(BG_RESPONSE)
    return () => {
      window.removeEventListener('beforeunload', handleCancel)
    }
  }, [handleCancel])

  const hasToShowCheckbox = useMemo(() => {
    if (isSignArbitrary) {
      return false
    }

    return Array.isArray(messages)
      ? isGenericOrSendAuthzGrant(messages?.map((msg) => msg.parsed) ?? null)
      : false
  }, [isSignArbitrary, messages])

  const isApproveBtnDisabled =
    !!signingError ||
    !!gasPriceError ||
    (hasToShowCheckbox === true && checkedGrantAuthBox === false)

  const NotAllowSignTxGasOptions = () => {
    const { viewAdditionalOptions } = useGasPriceContext()
    return viewAdditionalOptions ? (
      <div className='rounded-2xl p-4 mt-3 dark:bg-[#141414] bg-white-100'>
        <div className='flex items-center'>
          <p className='text-gray-500 dark:text-gray-100 text-sm font-medium tracking-wide'>
            Gas Fees <span className='capitalize'>({gasPriceOption.option})</span>
          </p>
          <Tooltip
            content={
              <p className='text-gray-500 dark:text-gray-100 text-sm'>
                You can choose higher gas fees for faster transaction processing.
              </p>
            }
          >
            <div className='relative ml-2'>
              <img src={Images.Misc.InfoCircle} alt='Hint' />
            </div>
          </Tooltip>
        </div>
        <GasPriceOptions.Selector className='mt-2' preSelected={false} />
        <GasPriceOptions.AdditionalSettings className='mt-5 p-0' showGasLimitWarning={true} />
        {gasPriceError ? (
          <p className='text-red-300 text-sm font-medium mt-2 px-1'>{gasPriceError}</p>
        ) : null}
      </div>
    ) : null
  }

  return (
    <div className='w-[400px] h-full relative self-center justify-self-center flex justify-center items-center mt-2'>
      <div className='relative w-[400px] overflow-clip rounded-md border border-gray-300 dark:border-gray-900'>
        <PopupLayout
          header={
            <div className='w-[396px]'>
              <Header
                imgSrc={chainInfo.chainSymbolImageUrl ?? GenericLight}
                title={
                  <Buttons.Wallet
                    brandLogo={
                      isCompassWallet() ? (
                        <img className='w-[24px] h-[24px] mr-1' src={Images.Logos.CompassCircle} />
                      ) : undefined
                    }
                    title={trim(walletName, 10)}
                    className='pr-4 cursor-default'
                  />
                }
                topColor={Colors.getChainColor(activeChain, chainInfos[activeChain])}
              />
            </div>
          }
        >
          <div
            className='px-7 py-3 overflow-y-auto relative'
            style={{
              height: `calc(100% - 72px - ${hasToShowCheckbox ? '110px' : '72px'})`,
            }}
          >
            <h2 className='text-center text-lg font-bold dark:text-white-100 text-gray-900 w-full'>
              Approve Transaction
            </h2>
            <div className='flex items-center mt-3 rounded-2xl dark:bg-gray-900 bg-white-100 p-4'>
              <Avatar
                avatarImage={siteLogo}
                avatarOnError={imgOnError(Images.Misc.Globe)}
                size='sm'
                className='rounded-full overflow-hidden'
              />
              <div className='ml-3'>
                <p className='capitalize text-gray-900 dark:text-white-100 text-base font-bold'>
                  {siteName}
                </p>
                <p className='lowercase text-gray-500 dark:text-gray-400 text-xs font-medium'>
                  {siteOrigin}
                </p>
              </div>
            </div>

            {!ethSignType && !isSignArbitrary && (
              <TransactionDetails parsedMessages={messages?.map((msg) => msg.parsed) ?? null} />
            )}

            {!ethSignType && !isSignArbitrary ? (
              <GasPriceOptions
                initialFeeDenom={dappFeeDenom}
                gasLimit={userPreferredGasLimit || recommendedGasLimit}
                setGasLimit={(value) => setUserPreferredGasLimit(value.toString())}
                recommendedGasLimit={recommendedGasLimit}
                gasPriceOption={
                  selectedGasOptionRef.current || allowSetFee
                    ? gasPriceOption
                    : { ...gasPriceOption, option: '' as GasOptions }
                }
                onGasPriceOptionChange={(value) => {
                  selectedGasOptionRef.current = true
                  setGasPriceOption(value)
                }}
                error={gasPriceError}
                setError={setGasPriceError}
                considerGasAdjustment={false}
                disableBalanceCheck={fee.granter || signOptions.disableBalanceCheck}
              >
                <Tabs
                  className='mt-3'
                  tabsList={[
                    { id: 'fees', label: 'Fees' },
                    //Hiding  memo for now.
                    //{ id: 'memo', label: 'Memo' },
                    {
                      id: 'messages',
                      label: `Messages${messages?.length ? ` (${messages.length})` : ''}`,
                    },
                    { id: 'data', label: 'Data' },
                  ]}
                  tabsContent={{
                    fees: allowSetFee ? (
                      <div className='rounded-2xl p-4 mt-3 dark:bg-gray-900 bg-white-100'>
                        <div className='flex items-center'>
                          <p className='text-gray-500 dark:text-gray-100 text-sm font-medium tracking-wide'>
                            Gas Fees <span className='capitalize'>({gasPriceOption.option})</span>
                          </p>
                          <Tooltip
                            content={
                              <p className='text-gray-500 dark:text-gray-100 text-sm'>
                                You can choose higher gas fees for faster transaction processing.
                              </p>
                            }
                          >
                            <div className='relative ml-2'>
                              <img src={Images.Misc.InfoCircle} alt='Hint' />
                            </div>
                          </Tooltip>
                        </div>

                        <GasPriceOptions.Selector className='mt-2' />
                        <div className='flex items-center justify-end'>
                          <GasPriceOptions.AdditionalSettingsToggle className='p-0 mt-3' />
                        </div>
                        <GasPriceOptions.AdditionalSettings
                          className='mt-2'
                          showGasLimitWarning={true}
                        />

                        {gasPriceError ? (
                          <p className='text-red-300 text-sm font-medium mt-2 px-1'>
                            {gasPriceError}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <div className='rounded-2xl p-4 mt-3 dark:bg-gray-900 bg-white-100'>
                          <StaticFeeDisplay
                            fee={fee}
                            error={gasPriceError}
                            setError={setGasPriceError}
                            disableBalanceCheck={fee.granter || signOptions.disableBalanceCheck}
                          />
                          <div className='flex items-center justify-end'>
                            <GasPriceOptions.AdditionalSettingsToggle className='p-0 mt-3' />
                          </div>
                          <NotAllowSignTxGasOptions />
                        </div>
                      </>
                    ),
                    memo: (
                      <div className='mt-3'>
                        <MemoInput
                          disabled={!!defaultMemo}
                          memo={defaultMemo ? defaultMemo : userMemo}
                          setMemo={(memo) => {
                            setUserMemo(memo)
                          }}
                        />
                      </div>
                    ),
                    messages: (
                      <div className='mt-3'>
                        {messages ? (
                          <MessageList
                            parsedMessages={messages.map((msg) => msg.parsed)}
                            onMessageSelect={(msg, index) => {
                              setSelectedMessage({
                                index,
                                parsed: messages[index].parsed,
                                raw: messages[index].raw,
                              })
                              setShowMessageDetailsSheet(true)
                            }}
                          />
                        ) : (
                          <div>
                            <p className='text-gray-500 dark:text-gray-100 text-sm'>
                              No information available. The transaction can still be approved.
                            </p>
                          </div>
                        )}
                      </div>
                    ),
                    data: (
                      <pre className='text-xs text-gray-900 dark:text-white-100 dark:bg-gray-900 bg-white-100 p-4 w-full overflow-x-auto mt-3 rounded-2xl'>
                        {JSON.stringify(txnDoc, null, 2)}
                      </pre>
                    ),
                  }}
                />
              </GasPriceOptions>
            ) : (
              <pre
                className={classNames(
                  'text-xs text-gray-900 dark:text-white-100 dark:bg-gray-900 bg-white-100 p-4 w-full overflow-x-auto mt-3 rounded-2xl',
                  {
                    'whitespace-normal break-words': isSignArbitrary,
                  },
                )}
              >
                {isSignArbitrary
                  ? (messages as unknown as string)
                  : // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    //@ts-ignore
                    JSON.stringify(JSON.parse(messages?.[0].parsed.message), null, 2)}
              </pre>
            )}

            {signingError ?? ledgerError ? <ErrorCard text={signingError ?? ledgerError} /> : null}
            <LedgerConfirmationModal
              showLedgerPopup={showLedgerPopup}
              onClose={() => {
                setShowLedgerPopup(false)
              }}
            />
            <SelectWalletSheet
              isOpen={showWalletSelector}
              onClose={() => setShowWalletSelector(false)}
              currentWalletInfo={currentWalletInfo}
              title='Select Wallet'
            />
            <MessageDetailsSheet
              isOpen={showMessageDetailsSheet}
              setIsOpen={setShowMessageDetailsSheet}
              onClose={() => setSelectedMessage(null)}
              message={selectedMessage}
            />
          </div>

          <div className='absolute bottom-0 left-0 py-3 px-7 dark:bg-black-100 bg-gray-50 w-full'>
            {hasToShowCheckbox && (
              <div className='flex flex-row items-center mb-3'>
                <input
                  type='checkbox'
                  className='cursor-pointer mr-2 h-4 w-4 bg-black-50'
                  checked={checkedGrantAuthBox}
                  onChange={(e) => setCheckedGrantAuthBox(e.target.checked)}
                />
                <Text color='text-gray-400 text-[15px]'>
                  I&apos;ve verified the wallet I&apos;m giving permissions to
                </Text>
              </div>
            )}

            <div className='flex items-center justify-center w-full space-x-3'>
              <Buttons.Generic color={Colors.gray900} onClick={handleCancel}>
                Reject
              </Buttons.Generic>
              <Buttons.Generic
                color={Colors.getChainColor(activeChain)}
                onClick={approveTransaction}
                disabled={isApproveBtnDisabled}
                className={`${isApproveBtnDisabled ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                Approve
              </Buttons.Generic>
            </div>
          </div>
        </PopupLayout>
      </div>
    </div>
  )
}

/**
 * This HOC helps makes sure that the txn signing request is decoded and the chain is set
 */
const withTxnSigningRequest = (Component: React.FC<any>) => {
  const Wrapped = () => {
    const [chain, setChain] = useState<SupportedChain>()
    const [_chainIdToChain, setChainIdToChain] = useState(chainIdToChain)
    const [isSignArbitrary, setIsSignArbitrary] = useState(false)

    const [txnData, setTxnData] = useState<any | null>(null)
    const [chainId, setChainId] = useState<string>()
    const [error, setError] = useState<{
      message: string
      code: string
    } | null>(null)

    const activeChain = useActiveChain()
    const setActiveChain = useSetActiveChain()
    const selectedNetwork = useSelectedNetwork()
    const setSelectedNetwork = useSetSelectedNetwork()

    useEffect(() => {
      decodeChainIdToChain().then(setChainIdToChain).catch(captureException)
    }, [])

    useEffect(() => {
      const getTxnData = async () => {
        const storage = await browser.storage.local.get([SIGN_REQUEST])
        const txnData = storage[SIGN_REQUEST]
        if (!txnData) {
          throw new Error('no-data')
        }
        return txnData
      }
      getTxnData()
        .then((txnData: Record<string, any>) => {
          const chainId = txnData.chainId ? txnData.chainId : txnData.signDoc?.chainId
          const chain = chainId ? (_chainIdToChain[chainId] as SupportedChain) : undefined

          if (txnData.signOptions.isADR36WithString) {
            setIsSignArbitrary(true)
          }

          setChain(chain)
          setChainId(chainId)
          setTxnData(txnData)
        })
        .catch((e) => {
          if (e.message === 'no-data') {
            setError({
              message: 'No transaction data was found, please retry the transaction from the dApp.',
              code: 'no-data',
            })
          } else {
            setError({
              message: 'Something went wrong, please try again.',
              code: 'unknown',
            })
          }
        })
    }, [_chainIdToChain])

    useEffect(() => {
      if (chain && chain !== activeChain) {
        setActiveChain(chain)
      }
      if (chain) {
        const isTestnet = ChainInfos[chain]?.testnetChainId === chainId
        if (!isTestnet && selectedNetwork === 'testnet') {
          setSelectedNetwork('mainnet')
        } else if (isTestnet && selectedNetwork === 'mainnet') {
          setSelectedNetwork('testnet')
        }
      }
    }, [activeChain, chain, setActiveChain, selectedNetwork, setSelectedNetwork, chainId])

    if (chain === activeChain && txnData && chainId) {
      return <Component data={txnData} chainId={chainId} isSignArbitrary={isSignArbitrary} />
    }

    if (error) {
      const heading = ((code) => {
        switch (code) {
          case 'no-data':
            return 'No Transaction Data'
          default:
            return 'Something Went Wrong'
        }
      })(error.code)

      return (
        <PopupLayout
          className='self-center justify-self-center'
          header={<Header title='Sign Transaction' topColor='#E54f47' />}
        >
          <div className='h-full w-full flex flex-col gap-4 items-center justify-center'>
            <h1 className='text-red-300 text-2xl font-bold px-4 text-center'>{heading}</h1>
            <p className='text-black-100 dark:text-white-100 text-sm font-medium px-4 text-center'>
              {error.message}
            </p>
            <button
              className='mt-8 py-1 px-4 text-center text-sm font-medium dark:text-white-100 text-black-100 bg-indigo-300 rounded-full'
              onClick={() => {
                window.close()
              }}
            >
              Close Wallet
            </button>
          </div>
        </PopupLayout>
      )
    }

    return (
      <PopupLayout
        className='self-center justify-self-center'
        header={<Header title='Sign Transaction' topColor='#E54f47' />}
      >
        <div className='h-full w-full flex flex-col gap-4 items-center justify-center'>
          <LoaderAnimation color='white' />
        </div>
      </PopupLayout>
    )
  }

  Wrapped.displayName = `withTxnSigningRequest(${Component.displayName})`

  return Wrapped
}

export default withTxnSigningRequest(SignTransaction)
