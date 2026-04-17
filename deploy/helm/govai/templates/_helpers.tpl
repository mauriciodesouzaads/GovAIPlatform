{{/*
Common helpers for the govai chart.
*/}}

{{- define "govai.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "govai.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "govai.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "govai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "govai.selectorLabels" -}}
app.kubernetes.io/name: {{ include "govai.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Validate preconditions at render time.
Enterprise deployments MUST use existingSecret — the chart never generates secrets.
*/}}
{{- define "govai.validatePreconditions" -}}
{{- if and (gt (int .Values.replicaCount.api) 1) (ne .Values.features.streamRegistryMode "distributed") -}}
{{- fail "replicaCount.api > 1 requires features.streamRegistryMode=distributed (ADR-012)" -}}
{{- end -}}
{{- if and (not .Values.postgres.deployInCluster) (not .Values.postgres.host) -}}
{{- fail "postgres.host is required when postgres.deployInCluster=false. Use --set postgres.host=..." -}}
{{- end -}}
{{- if and (not .Values.redis.deployInCluster) (not .Values.redis.host) -}}
{{- fail "redis.host is required when redis.deployInCluster=false. Use --set redis.host=..." -}}
{{- end -}}
{{- end -}}
