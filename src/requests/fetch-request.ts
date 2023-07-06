import { BaseDex } from '@dex/base-dex';
import { Asset, Token } from '@dex/models/asset';
import { LiquidityPool } from '@dex/models/liquidity-pool';
import { Dexter } from '@app/dexter';
import { AssetMetadata, Transaction, UTxO } from '@app/types';
import { BaseDataProvider } from '@providers/data/base-data-provider';
import { tokensMatch } from "@app/utils";

export class FetchRequest {

    private _dexter: Dexter;
    private _onDexs: BaseDex[] = [];
    private _filteredTokens: Token[] = [];
    private _filteredPairs: Array<Token[]> = [];

    constructor(dexter: Dexter) {
        this._dexter = dexter;
        this._onDexs = Object.values(dexter.availableDexs);
    }

    /**
     * Set the DEX(s) Dexter will fetch data on.
     */
    public onDexs(dexs: string | string[]): FetchRequest {
        (Array.isArray(dexs) ? dexs : [dexs]).forEach((dexName: string) => {
            if (! Object.keys(this._dexter.availableDexs).includes(dexName)) {
                throw new Error(`DEX ${dexName} is not available.`);
            }

            this._onDexs = this._onDexs.filter((dex: BaseDex) => {
                return dex.name !== dexName;
            }).concat(this._dexter.availableDexs[dexName]);
        });

        return this;
    }

    /**
     * Fetch data on all available DEXs.
     */
    public onAllDexs(): FetchRequest {
        this._onDexs = Object.values(this._dexter.availableDexs);

        return this;
    }

    /**
     * Only fetch pools containing these tokens.
     */
    public forTokens(tokens: Token[]): FetchRequest {
        this._filteredTokens = tokens;

        return this;
    }

    /**
     * Only fetch pools containing these token pairs.
     */
    public forTokenPairs(tokenPairs: Array<Token[]>): FetchRequest {
        tokenPairs.forEach((pair: Token[]) => {
           if (pair.length !== 2) {
               throw new Error('Token pair must contain two tokens.');
           }

           if (tokensMatch(pair[0], pair[1])) {
               throw new Error('Provided pair contains the same tokens. Ensure each pair has differing tokens.');
           }
        });

        this._filteredPairs = tokenPairs;

        return this;
    }

    /**
     * Fetch latest state for a liquidity pool.
     */
    public getLiquidityPoolState(liquidityPool: LiquidityPool): Promise<LiquidityPool> {
        const dexInstance: BaseDex | undefined = this._dexter.dexByName(liquidityPool.dex);

        if (! dexInstance) {
            return Promise.reject('Unable to determine DEX from the provided liquidity pool.');
        }

        let liquidityPoolPromises: Promise<LiquidityPool[]>;

        if (this._dexter.dataProvider) {
            if (! liquidityPool.address) {
                return Promise.reject('Liquidity pool must have a set address.');
            }

            const filterableAsset: Asset = liquidityPool.assetA === 'lovelace'
                ? liquidityPool.assetB as Asset
                : liquidityPool.assetA as Asset;

            liquidityPoolPromises = this._dexter.dataProvider.utxos(liquidityPool.address, filterableAsset)
                .then(async (utxos: UTxO[]) => {
                    return await Promise.all(
                        utxos.map(async (utxo: UTxO) => {
                            return await dexInstance.liquidityPoolFromUtxo(this._dexter.dataProvider as BaseDataProvider, utxo);
                        })
                    ).then((liquidityPools: (LiquidityPool | undefined)[]) => {
                        return liquidityPools.filter((liquidityPool?: LiquidityPool) => {
                            return liquidityPool !== undefined;
                        }) as LiquidityPool[];
                    })
                });
        } else {
            liquidityPoolPromises = dexInstance.api.liquidityPools(liquidityPool.assetA, liquidityPool.assetB);
        }

        return liquidityPoolPromises
            .then(async (liquidityPools: LiquidityPool[]) => {
                const possiblePools: LiquidityPool[] = liquidityPools.filter((pool?: LiquidityPool) => {
                    return pool !== undefined && pool.uuid === liquidityPool.uuid;
                }) as LiquidityPool[];

                if (possiblePools.length > 1) {
                    return Promise.reject('Encountered more than 1 possible pool state.');
                }

                if (this._dexter.config.shouldFetchMetadata) {
                    await this.fetchAssetMetadata(possiblePools);
                }

                return possiblePools[0];
            });
    }

    /**
     * Fetch all liquidity pools matching token filters.
     */
    public getLiquidityPools(): Promise<LiquidityPool[]> {
        const liquidityPoolPromises: Promise<LiquidityPool[]>[] =
            this._onDexs.map((dex: BaseDex) => {
                if (! this._dexter.dataProvider) {
                    return this.fetchPoolsFromApi(dex);
                }

                return dex.liquidityPools(this._dexter.dataProvider as BaseDataProvider)
                    .catch(() => {
                        // Attempt fallback to API
                        return this._dexter.config.shouldFallbackToApi
                            ? this.fetchPoolsFromApi(dex)
                            : [];
                    });
            });

        return Promise.all(
            liquidityPoolPromises,
        ).then(async (mappedLiquidityPools: Awaited<LiquidityPool[]>[]) => {
            const liquidityPools: LiquidityPool[] = mappedLiquidityPools
                .flat()
                .filter((pool: LiquidityPool) => this.poolMatchesFilter(pool));

            if (this._dexter.config.shouldFetchMetadata) {
                await this.fetchAssetMetadata(liquidityPools);
            }

            return liquidityPools;
        });
    }

    /**
     * Fetch historic states for a liquidity pool.
     */
    public async getLiquidityPoolHistory(liquidityPool: LiquidityPool): Promise<LiquidityPool[]> {
        if (! this._dexter.dataProvider) {
            return []; // todo
        }

        const transactions: Transaction[] = await this._dexter.dataProvider.assetTransactions(liquidityPool.lpToken);

        const liquidityPoolPromises: Promise<LiquidityPool | undefined>[] = transactions.map(async (transaction: Transaction) => {
            const utxos: UTxO[] = await (this._dexter.dataProvider as BaseDataProvider)
                .transactionUtxos(transaction.hash);

            const relevantUtxo: UTxO | undefined = utxos.find((utxo: UTxO) => {
                return utxo.address === liquidityPool.address;
            });

            if (! relevantUtxo) {
                return undefined;
            }

            return await this._dexter.availableDexs[liquidityPool.dex].liquidityPoolFromUtxo(
                this._dexter.dataProvider as BaseDataProvider,
                relevantUtxo,
            ) as LiquidityPool | undefined;
        });

        return await Promise.all(liquidityPoolPromises)
            .then((liquidityPools: (LiquidityPool | undefined)[]) => {
                return liquidityPools.filter((pool?: LiquidityPool) => {
                    return pool !== undefined;
                }) as LiquidityPool[];
            });
    }

    /**
     * Fetch asset metadata for the assets in the provided liquidity pools.
     */
    private async fetchAssetMetadata(liquidityPools: LiquidityPool[]) {
        const assets: Asset[] = liquidityPools.reduce((results: Asset[], liquidityPool: LiquidityPool) => {
            if (liquidityPool.assetA !== 'lovelace' && ! results.some((asset: Asset) => asset.id() === (liquidityPool.assetA as Asset).id())) {
                results.push(liquidityPool.assetA);
            }
            if (liquidityPool.assetB !== 'lovelace' && ! results.some((asset: Asset) => asset.id() === (liquidityPool.assetB as Asset).id())) {
                results.push(liquidityPool.assetB);
            }

            return results;
        }, [] as Asset[]);

        await this._dexter.metadataProvider.fetch(assets)
            .then((response: AssetMetadata[]) => {
                liquidityPools.forEach((liquidityPool: LiquidityPool) => {
                    [liquidityPool.assetA, liquidityPool.assetB].forEach((asset: Token) => {
                        if (! (asset instanceof Asset)) {
                            return;
                        }

                        const responseAsset: AssetMetadata | undefined = response.find((metadata: AssetMetadata) => {
                            return (metadata.policyId === asset.policyId) && (metadata.nameHex === asset.nameHex);
                        });

                        asset.decimals = responseAsset ? responseAsset.decimals : 0;
                    });
                });
            });
    }

    /**
     * Check if a pools assets match the supplied token filters.
     */
    private poolMatchesFilter(liquidityPool: LiquidityPool): boolean {
        if (! this._filteredTokens.length && ! this._filteredPairs.length) {
            return true;
        }

        const inFilteredTokens: boolean = this._filteredTokens.some((filterToken: Token) => {
            return tokensMatch(filterToken, liquidityPool.assetA) || tokensMatch(filterToken, liquidityPool.assetB);
        });
        const inFilteredPairs: boolean = this._filteredPairs.some((filterPair: Token[]) => {
            return (tokensMatch(filterPair[0], liquidityPool.assetA) && tokensMatch(filterPair[1], liquidityPool.assetB))
                || (tokensMatch(filterPair[0], liquidityPool.assetB) && tokensMatch(filterPair[1], liquidityPool.assetA));
        });

        return inFilteredTokens || inFilteredPairs;
    }

    /**
     * Fetch liquidity pools from DEX APIs using the provided token filters.
     */
    private fetchPoolsFromApi(dex: BaseDex): Promise<LiquidityPool[]> {
        const filterTokenPromises: Promise<LiquidityPool[]>[] = this._filteredTokens.map((token: Token) => {
            return dex.api.liquidityPools(token)
                .catch(() => []);
        });
        const filterPairPromises: Promise<LiquidityPool[]>[] = this._filteredPairs.map((pair: Token[]) => {
            return dex.api.liquidityPools(pair[0], pair[1])
                .catch(() => []);
        });

        return Promise.all(
            filterTokenPromises.concat(filterPairPromises).flat(),
        ).then((allLiquidityPools: Awaited<LiquidityPool[]>[]) => allLiquidityPools.flat());
    }

}
