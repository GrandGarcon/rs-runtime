import { IProxyAdapter } from "../../rs-core/adapter/IProxyAdapter.ts";
import { Framework } from "@superfluid-finance/sdk-core";
import { ethers } from "hardhat";
import { AdapterContext } from "../../rs-core/ServiceContext.ts";
import { } from ""
export interface SuperfluidAdapterInterface {
    networkName: string,
    provider: any,
    dataMode: string,
    resolverAddress: string,
    protocolReleaseVersion: string,

}

export interface SignerParams {
    privKey: any,
    provider: ethers.provider


}





export default class superfluidPaymentStreams implements IProxyAdapter {

    constructor(public context: AdapterContext, public props: SuperfluidAdapterInterface) { }

    async createSigner(msg: SignerParams): Promise<any> {
        const sf = await Framework.create({
            networkName: "matic",
            provider: ethers.provider,
        });
       const signer = sf.createSigner({
            privateKey: "<TEST_ACCOUNT_PRIVATE_KEY>",
            provider: ethers.provider,
        });
        return signer;
    }
}