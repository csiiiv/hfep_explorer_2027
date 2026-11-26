export interface MoneyBreakdown {
  infra: number;
  equipment: number;
  motor_vehicle: number;
  total: number;
}

export interface BudgetLineItem {
  status: string;
  category: string;
  subcategory: string;
  nep: MoneyBreakdown;
  gab: MoneyBreakdown;
  variance: MoneyBreakdown;
  senate: MoneyBreakdown;
}

export interface MatchedFile {
  filename: string;
  relative_path: string;
  local_path: string;
  subfolder?: string;
  ext: string;
  bytes: number;
}

export interface FacilityDownload {
  downloaded: boolean;
  reason?: string;
  match_type?: string;
  match_confidence?: number;
  needs_review?: boolean;
  matched_subfolders?: string[];
  file_count: number;
  total_bytes: number;
  zip_path?: string | null;
  files: MatchedFile[];
}

export interface FacilityRecord {
  facility_code: string;
  facility: string;
  region: string;
  province: string;
  category: string;
  subcategory: string;
  budget: {
    nep_total: number;
    gab_total: number;
    variance_total: number;
    senate_total: number;
    statuses: string[];
  };
  budget_line_items: BudgetLineItem[];
  resource: {
    resource_code: string;
    resource_kind: string;
    resource_id: string | null;
    canonical_url: string | null;
    access_status: string;
  };
  download: FacilityDownload;
}

export interface FacilitiesCatalog {
  generated_at: string;
  counts: {
    total_facilities: number;
    downloaded_facilities: number;
    pending_facilities: number;
    needs_review: number;
  };
  facilities: FacilityRecord[];
}

export interface ResourceSubfolder {
  subfolder: string;
  file_count: number;
  total_bytes: number;
  files: MatchedFile[];
  match?: {
    matched_facility_count: number;
    best_facility_code: string | null;
    best_facility_name: string | null;
    best_score: number;
  };
}

export interface ResourceRecord {
  resource_code: string;
  resource_kind: string;
  resource_id: string | null;
  canonical_url: string | null;
  access_status: string;
  n_facilities: number;
  is_shared: boolean;
  subfolders: ResourceSubfolder[];
}

export interface ResourcesCatalog {
  generated_at: string;
  resources: ResourceRecord[];
}

export type ValidationStatus = "verified" | "incomplete" | "needs_followup" | "mismatch";

export interface ValidationRecord {
  status: ValidationStatus | null;
  checklist: {
    site_readiness?: boolean;
    land_ownership?: boolean;
    hazard_assessment?: boolean;
    sdp_daed?: boolean;
    manpower?: boolean;
  };
  note: string;
  updated_at?: string;
  updated_by_username?: string | null;
  updated_by_name?: string | null;
}

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: string;
}

export interface AuditLogEntry {
  id: number;
  timestamp: string;
  username: string;
  action: string;
  facility_code: string | null;
  before: unknown;
  after: unknown;
}
