#!/bin/sh
# Creates (or updates) the IAM user the cloud chat signs its short-term Bedrock API keys with.
# The user has no console access, and its only permissions are calling the one model, and only
# with short-term keys. Safe to rerun: it updates the policy in place.
#
#   sh scripts/aws/bedrock-signer.sh              # user + policy
#   sh scripts/aws/bedrock-signer.sh --create-key # also make an access key and write it,
#                                                 # with LLM_URL/LLM_MODEL, into volcano/cloud.env
# Then deploy the variables (see README "Deploying to the cloud").
#
# To rotate: rerun with --create-key, deploy, then delete the old key:
#   aws iam delete-access-key --user-name payroll-bedrock --access-key-id <old id>
set -eu

USER_NAME=payroll-bedrock
REGION=us-east-2
MODEL=openai.gpt-oss-120b-1:0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/volcano/cloud.env"

if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "IAM user $USER_NAME exists"
else
  aws iam create-user --user-name "$USER_NAME" --tags Key=app,Value=payroll Key=purpose,Value=bedrock-chat >/dev/null
  echo "Created IAM user $USER_NAME"
fi

aws iam put-user-policy --user-name "$USER_NAME" --policy-name PayrollBedrockChat --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeTheChatModel",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:$REGION::foundation-model/$MODEL"
    },
    {
      "Sid": "OnlyWithShortTermKeys",
      "Effect": "Allow",
      "Action": "bedrock:CallWithBearerToken",
      "Resource": "*",
      "Condition": { "StringEquals": { "bedrock:bearerTokenType": "SHORT_TERM" } }
    }
  ]
}
EOF
)"
echo "Policy PayrollBedrockChat set: $MODEL in $REGION, short-term keys only"

[ "${1:-}" = "--create-key" ] || exit 0

if [ "$(aws iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)" -ge 2 ]; then
  echo "$USER_NAME already has 2 access keys; delete the old one first." >&2
  exit 1
fi
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy volcano/cloud.env.example first)." >&2; exit 1; }

# The secret goes straight into the gitignored env file and is never printed.
KEY="$(aws iam create-access-key --user-name "$USER_NAME" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
ID="$(printf '%s' "$KEY" | cut -f1)"
SECRET="$(printf '%s' "$KEY" | cut -f2)"
# Next to the env file (same filesystem, so the rename is atomic), and removed on any failure.
TMP="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
grep -v -E '^(LLM_URL|LLM_MODEL|LLM_TOKEN|BEDROCK_ACCESS_KEY_ID|BEDROCK_SECRET_ACCESS_KEY)=' "$ENV_FILE" > "$TMP" || true
cat >> "$TMP" <<EOF
LLM_URL=https://bedrock-runtime.$REGION.amazonaws.com/openai/v1
LLM_MODEL=$MODEL
BEDROCK_ACCESS_KEY_ID=$ID
BEDROCK_SECRET_ACCESS_KEY=$SECRET
EOF
mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Created access key $ID and wrote it to volcano/cloud.env"
