export interface TrackingPayload {
  user_id: string;
  email_id: string;
  recipient: string;
  sender_email?: string;
  sent_at: string;
}

export interface TrackedEmail {
  email_id: string;
  user_id: string;
  recipient: string;
  sender_email?: string | null;
  sent_at: string;
  open_count: number;
  created_at: string;
}

export interface OpenEvent {
  id: number;
  email_id: string;
  user_id: string;
  recipient: string;
  opened_at: string;
  ip_address: string | null;
  user_agent: string | null;
  geo_country: string | null;
  geo_region: string | null;
  geo_city: string | null;
  latitude: number | null;
  longitude: number | null;
  device_type: "phone" | "computer" | "other";
  is_duplicate: number;
  is_sender_suppressed: number;
  suppression_reason: string | null;
}
