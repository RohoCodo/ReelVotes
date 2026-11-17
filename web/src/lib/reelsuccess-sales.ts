import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase-core";
export { csvCell, downloadCsv } from "./reelsuccess-export";

export type MovieMatch = { movieId: string; title: string; releaseYear?: number };
export type SalesFilters = {
  genre?: string;
  releaseYear?: number;
  decade?: number;
  screeningType?: string;
  weekday?: number;
  startTime?: string;
};
export interface SalesRecord {
  movieId: string;
  movieTitle: string;
  screeningDate: string;
  startTime: string;
  auditorium: string;
  capacity: number | null;
  ticketsSold: number | null;
  complimentaryTickets: number | null;
  grossRevenueCents: number | null;
  ticketPriceCents: number | null;
  screeningType: string;
  genre: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  source: string;
  importBatchId: string;
  rowNumber: number;
}
export interface ImportPreview {
  draftId: string | null;
  headers: string[];
  mapping: Record<string, string>;
  rows: {
    rowNumber: number;
    raw: Record<string, unknown>;
    record: SalesRecord | null;
    errors: string[];
    warnings: string[];
  }[];
  movieTitles: string[];
  counts: { total: number; valid: number; invalid: number; duplicates: number };
  warnings: string[];
}
export interface MovieMetrics {
  movieId: string;
  title: string;
  releaseYear: number | null;
  genre: string | null;
  runtimeMinutes: number | null;
  screenings: number;
  paidAdmissions: number | null;
  grossRevenueCents: number | null;
  averageTickets: number | null;
  averageOccupancy: number | null;
  revenuePerScreeningCents: number | null;
  averageTicketPriceCents: number | null;
  performanceIndex: number | null;
  baselineCount: number;
  baselineScreeningKeys: string[];
  expectedPaidAdmissions: number | null;
  indexReason: string;
}
export interface SalesAnalytics {
  period: { startDate: string; endDate: string };
  currency: string;
  summary: {
    screenings: number;
    paidAdmissions: number | null;
    grossRevenueCents: number | null;
    averageTickets: number | null;
    averageOccupancy: number | null;
  };
  coverage: { paidAdmissions: number; revenue: number; capacity: number };
  movies: MovieMetrics[];
  trend: { date: string; paidAdmissions: number | null; grossRevenueCents: number | null; screenings: number }[];
  screenings: SalesRecord[];
  warnings: string[];
  lastImportedAt: string | null;
  definitions: Record<string, string>;
  methodology: string;
  filterOptions: { genres: string[]; releaseYears: number[]; screeningTypes: string[]; startTimes: string[] };
}
export interface SalesImport {
  id: string;
  fileName: string;
  importedAt: string;
  rowCount: number;
  source: string;
}

export const previewSalesImport = httpsCallable<{
  theaterKey: string;
  fileName: string;
  fileBase64: string;
  mapping?: Record<string, string>;
  movieMatches?: Record<string, MovieMatch>;
}, ImportPreview>(functions, "reelSuccessPreviewSalesImport");
export const confirmSalesImport = httpsCallable<{ theaterKey: string; draftId: string }, {
  ok: boolean; importId: string; rowCount: number;
}>(functions, "reelSuccessConfirmSalesImport");
export const getSalesAnalytics = httpsCallable<{
  theaterKey: string; startDate: string; endDate: string; filters?: SalesFilters;
}, SalesAnalytics>(functions, "reelSuccessGetSalesAnalytics");
export const listSalesImports = httpsCallable<{ theaterKey: string; cursor?: string }, {
  imports: SalesImport[]; nextCursor?: string;
}>(functions, "reelSuccessListSalesImports");

export function salesErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}
