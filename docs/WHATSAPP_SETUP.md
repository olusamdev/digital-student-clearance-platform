# DSCP WhatsApp Business Cloud API setup

## Meta configuration

1. In Meta for Developers, create or select the college's Meta app and add the **WhatsApp** product. Connect the college's WhatsApp Business Account and production phone number.
2. Create and get approval for a **Utility** message template named `dscp_clearance_request` (or set the actual approved name in Supabase). Use this body with six text parameters:

   `New clearance request for {{1}} (Reg. No. {{2}}). Office: {{3}}. Department: {{4}}. Programme: {{5}}. Session: {{6}}. Use the buttons below to Clear or Comment.`

   Add two **Quick Reply** buttons in this order, with exact labels **Clear** and **Comment**. The function sends request-specific payloads for the buttons. The template is required because a newly assigned officer may not have an open 24-hour WhatsApp conversation with the college.
3. Set the Meta webhook callback URL to:

   `https://cipsazscgpyoaxwukmaw.supabase.co/functions/v1/whatsapp-clearance`

   Set the verify token to the same random value as `WHATSAPP_VERIFY_TOKEN`, verify the webhook, and subscribe to the WhatsApp `messages` field.
4. In Supabase project `cipsazscgpyoaxwukmaw`, add these Edge Function secrets:

   - `WHATSAPP_ACCESS_TOKEN` — a durable System User access token with the required WhatsApp messaging permissions.
   - `WHATSAPP_PHONE_NUMBER_ID` — the connected WhatsApp sender phone-number ID, not the displayed phone number.
   - `WHATSAPP_APP_SECRET` — the Meta app secret used to verify `X-Hub-Signature-256`.
   - `WHATSAPP_VERIFY_TOKEN` — a long, random webhook verification string.
   - `WHATSAPP_TEMPLATE_NAME` — approved template name; normally `dscp_clearance_request`.
   - `WHATSAPP_TEMPLATE_LANGUAGE` — the exact approved template language code, e.g. `en`.
   - `WHATSAPP_GRAPH_API_VERSION` — a currently supported Graph API version, e.g. `v23.0`; keep this aligned with Meta's current version.

## DSCP operation

- SuperAdmin enters each officer's number in international format (country code plus digits, e.g. `2348012345678`) and enables or disables WhatsApp actions per officer.
- On student clearance submission, DSCP routes each request to active officers assigned to that office. HOD notifications are limited to the student's department; Bursary and Registrar use their existing role/office rules.
- Officers can choose **Clear** or **Comment** from the approved template. Clear is applied only when the sender number maps to an active, WhatsApp-enabled officer who is assigned to that request and the request is still actionable.
- Choosing **Comment** opens a 15-minute window to reply with a typed remark. Comments and decisions are written to the existing clearance comments and audit tables. Duplicate Meta webhook message IDs are ignored.
- After the required office clearances are all cleared, WhatsApp-enabled Provost accounts receive a notice that Final Assent is ready in the existing Provost portal. Final Assent itself remains in the DSCP portal.

## Verification checklist

1. Configure the Meta secrets and approved template before enabling WhatsApp for any live officer.
2. Add one test officer's WhatsApp number and enable it in SuperAdmin staff management.
3. Submit a test student's clearance request and verify the correct officer receives the template and buttons.
4. Test **Comment** with a typed remark, then verify it appears in the clearance queue and audit trail.
5. Test **Clear**, verify the request status and student notification, and confirm the next-workflow notification is sent only when all required clearances are complete.
6. Test an unassigned number, a disabled officer, a duplicate webhook delivery, and an already-cleared request. None should change clearance state.
