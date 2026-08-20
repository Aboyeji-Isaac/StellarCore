export type Sep38StellarAssetIdentifier = `stellar:${string}`;
export type Sep38StellarLiquidityPoolAssetIdentifier = `stellar:${string}:lp`;
export type Sep38Iso4217AssetIdentifier = `iso4217:${string}`;
export type Sep38AssetIdentifier =
  | Sep38StellarAssetIdentifier
  | Sep38Iso4217AssetIdentifier;

export type ParsedSep38AssetIdentifier =
  | Readonly<{
      scheme: "iso4217";
      code: string;
      value: Sep38Iso4217AssetIdentifier;
    }>
  | Readonly<{
      scheme: "stellar";
      code: string;
      issuer?: string;
      liquidityPoolId?: never;
      value: Sep38StellarAssetIdentifier;
    }>
  | Readonly<{
      scheme: "stellar";
      liquidityPoolId: string;
      code?: never;
      issuer?: never;
      value: Sep38StellarLiquidityPoolAssetIdentifier;
    }>;

export type Sep38DeliveryMethod = Readonly<{
  name: string;
  description: string;
}>;

export type Sep38Asset = Readonly<{
  asset: Sep38AssetIdentifier;
  countryCodes: readonly string[];
  sellDeliveryMethods: readonly Sep38DeliveryMethod[];
  buyDeliveryMethods: readonly Sep38DeliveryMethod[];
}>;

export type Sep38Info = Readonly<{
  assets: readonly Sep38Asset[];
}>;

export type Sep38SupportedPair = Readonly<{
  sellAsset: Sep38AssetIdentifier;
  buyAsset: Sep38AssetIdentifier;
}>;

export type Sep38PairPrice = Sep38SupportedPair &
  Readonly<{
    price: string;
    decimals: number;
  }>;

export type Sep38PricesRequest =
  | Readonly<{
      sellAsset: Sep38AssetIdentifier;
      sellAmount: string;
      buyAsset?: never;
      buyAmount?: never;
      sellDeliveryMethod?: string;
      buyDeliveryMethod?: string;
      countryCode?: string;
    }>
  | Readonly<{
      buyAsset: Sep38AssetIdentifier;
      buyAmount: string;
      sellAsset?: never;
      sellAmount?: never;
      sellDeliveryMethod?: string;
      buyDeliveryMethod?: string;
      countryCode?: string;
    }>;

export type Sep38Prices = Readonly<{
  direction: "sell" | "buy";
  requestedAsset: Sep38AssetIdentifier;
  requestedAmount: string;
  pairs: readonly Sep38PairPrice[];
}>;

export type Sep38PairDiscoveryFailure = Readonly<{
  asset: Sep38AssetIdentifier;
  code: string;
  status?: number;
}>;

export type Sep38CapabilityDiscovery = Readonly<{
  quoteServer: string;
  info: Sep38Info;
  pairs: readonly Sep38SupportedPair[];
  failures: readonly Sep38PairDiscoveryFailure[];
}>;

export type Sep38FeeDetail = Readonly<{
  name: string;
  description?: string;
  amount: string;
}>;

export type Sep38Fee = Readonly<{
  total: string;
  asset: Sep38AssetIdentifier;
  details: readonly Sep38FeeDetail[];
}>;

type Sep38QuoteRequestBase = Readonly<{
  sellAsset: Sep38AssetIdentifier;
  buyAsset: Sep38AssetIdentifier;
  countryCode?: string;
}> &
  (
    | Readonly<{
        sellDeliveryMethod?: string;
        buyDeliveryMethod?: never;
      }>
    | Readonly<{
        buyDeliveryMethod?: string;
        sellDeliveryMethod?: never;
      }>
  );

type Sep38QuoteAmount =
  | Readonly<{ sellAmount: string; buyAmount?: never }>
  | Readonly<{ buyAmount: string; sellAmount?: never }>;

export type Sep38IndicativePriceRequest = Sep38QuoteRequestBase &
  Sep38QuoteAmount &
  Readonly<{ context: "sep6" | "sep31" }>;

export type Sep38IndicativePrice = Readonly<{
  sellAsset: Sep38AssetIdentifier;
  buyAsset: Sep38AssetIdentifier;
  totalPrice: string;
  price: string;
  sellAmount: string;
  buyAmount: string;
  fee: Sep38Fee;
}>;

export type Sep38FirmQuoteRequest = Sep38QuoteRequestBase &
  Sep38QuoteAmount &
  Readonly<{
    context: "sep6" | "sep24" | "sep31";
    expireAfter?: string;
  }>;

export type Sep38FirmQuote = Readonly<{
  id: string;
  expiresAt: string;
  totalPrice: string;
  price: string;
  sellAsset: Sep38AssetIdentifier;
  sellAmount: string;
  sellDeliveryMethod?: string;
  buyAsset: Sep38AssetIdentifier;
  buyAmount: string;
  buyDeliveryMethod?: string;
  fee: Sep38Fee;
}>;

export type Sep38Authentication = Readonly<{
  token: string;
}>;

export type Sep38FirmQuoteWireRequest = Readonly<{
  sell_asset: Sep38AssetIdentifier;
  buy_asset: Sep38AssetIdentifier;
  sell_amount?: string;
  buy_amount?: string;
  expire_after?: string;
  sell_delivery_method?: string;
  buy_delivery_method?: string;
  country_code?: string;
  context: "sep6" | "sep24" | "sep31";
}>;
