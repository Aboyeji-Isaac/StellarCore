export type PublicCorridor = Readonly<{
  slug: string;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  anchorCount: number;
}>;

export type PublicCorridorsResponse = Readonly<{
  corridors: readonly PublicCorridor[];
  count: number;
}>;

export type CorridorsApiErrorResponse = Readonly<{
  error: Readonly<{
    code: "internal_error";
    message: string;
  }>;
}>;

export type CorridorsApiResult =
  | Readonly<{ status: 200; body: PublicCorridorsResponse }>
  | Readonly<{ status: 500; body: CorridorsApiErrorResponse }>;

