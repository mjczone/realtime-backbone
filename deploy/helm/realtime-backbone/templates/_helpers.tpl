{{- define "rtb.labels" -}}
app.kubernetes.io/part-of: realtime-backbone
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "rtb.selector" -}}
app.kubernetes.io/name: centrifugo
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "rtb.image" -}}
{{ .Values.centrifugo.image.registry }}/{{ .Values.centrifugo.image.repository }}:{{ .Values.centrifugo.image.tag }}
{{- end }}

{{- define "rtb.gatewaySelector" -}}
app.kubernetes.io/name: realtime-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
