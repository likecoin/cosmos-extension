import { CosmWasmChain, Cw20Denoms } from '@leapwallet/cosmos-wallet-sdk/dist/constants/cw20-denoms';
import { useQuery } from '@tanstack/react-query';

import { useActiveChain, useCW20TokensStore } from '../store';
import { useGetStorageLayer } from './global-vars';
import { initResourceFromS3 } from './initResourceFromS3';

const CW20_TOKENS = 'cw20-tokens';
const CW20_TOKENS_LAST_UPDATED_AT = 'cw20-tokens-last-updated-at';

export function useFetchCW20Tokens() {
  const activeChain = useActiveChain();
  const storage = useGetStorageLayer();
  const { setCW20Tokens } = useCW20TokensStore();

  useQuery(
    ['fetch-cw20-tokens', activeChain],
    () => {
      if (activeChain) {
        const resourceKey = `${activeChain}-${CW20_TOKENS}`;
        const resourceURL = `https://assets.leapwallet.io/cosmos-registry/v1/denoms/${activeChain}/cw20.json`;

        const lastUpdatedAtKey = `${activeChain}-${CW20_TOKENS_LAST_UPDATED_AT}`;
        const lastUpdatedAtURL = `https://assets.leapwallet.io/cosmos-registry/v1/denoms/${activeChain}/cw20-last-updated-at.json`;

        initResourceFromS3({
          storage,
          setResource: setCW20Tokens,
          resourceKey,
          resourceURL,
          lastUpdatedAtKey,
          lastUpdatedAtURL,
          defaultResourceData: Cw20Denoms[activeChain as CosmWasmChain] ?? {},
        });
      }
    },
    {
      retry: (failureCount: number, error: any) => {
        if (error.response?.status === 404 || error.response?.status === 403 || error.response?.status === 429) {
          return false;
        }

        return failureCount < 3;
      },
    },
  );
}
