"""HCCS AWS account (688066488567) — everything ctbk runs there.

Imported (created imperatively 2026-09-11 … 09-25, adopted here):
- the avail cascade Lambda (`ctbk-avail-cascade-v5`) + its role, log group,
  and the v5/v6 tick schedules;
- the `pyrmts-engine` Batch stack (Fargate Spot CE, queue, execution role,
  log group) + the three ECR repos.

New:
- GitHub OIDC provider + `ctbk-gha` role: CI's HCCS AWS identity (Batch
  submit for the smg-v1 / rides fills, read-only checks for `infra-drift`),
  no long-lived keys.
- Secrets Manager `ctbk/r2-access-key-id` / `ctbk/r2-secret-access-key`,
  readable by the Batch execution role — the engine job def references them
  (`secrets` block) instead of carrying R2 creds as plaintext env / submit
  overrides. Secret VALUES are set out-of-band (`aws secretsmanager
  put-secret-value`), never in code or Pulumi state.

Deliberately unmanaged: the `pyrmts-engine` job definition (a new revision
per engine image — `ctbk gbfs engine jobdef` copies the latest revision's
shape forward, secrets block included) and the Lambda's image + environment
(deployed by `gbfs/lambda/deploy-image.py`; `ignore_changes`, and the env is
kept as a secret output so the adopted values stay encrypted in state).
"""
import json

import pulumi
import pulumi_aws as aws

ACCOUNT = '688066488567'
REGION = 'us-east-1'
GITHUB_REPO = 'hudcostreets/ctbk.dev'

LAMBDA = 'ctbk-avail-cascade-v5'
TICKS = {
    'ctbk-avail-cascade-v5-tick': ('cron(3/5 * * * ? *)', 'avail-v5 cascade fill', 'avail-v5'),
    'ctbk-avail-cascade-v6-tick': ('cron(4/5 * * * ? *)', 'avail-v6 cascade fill (LU-attributed successor)', 'avail-v6'),
}
BATCH_SUBNETS = [
    'subnet-0653300a0f9eb4583', 'subnet-00198b05a8550ff58', 'subnet-02855819db8e9eef9',
    'subnet-0f9e4bf751ef82fb6', 'subnet-082bb5ee050452f9a', 'subnet-067a10f3341418056',
]
BATCH_SG = 'sg-0edaa1b17efc832eb'


def _assume(service: str) -> str:
    return json.dumps({
        'Version': '2012-10-17',
        'Statement': [{'Effect': 'Allow', 'Principal': {'Service': service}, 'Action': 'sts:AssumeRole'}],
    })


def _imp(id_: str, **kw) -> pulumi.ResourceOptions:
    return pulumi.ResourceOptions(import_=id_, protect=True, **kw)


def provision() -> None:
    # ── ECR ───────────────────────────────────────────────────────────
    for name in ('ctbk-avail-lambda', 'ctbk-engine', 'pyrmts-engine'):
        aws.ecr.Repository(
            name, name=name, image_tag_mutability='MUTABLE',
            image_scanning_configuration={'scan_on_push': False},
            encryption_configurations=[{'encryption_type': 'AES256'}],
            opts=_imp(name),
        )

    # ── avail cascade Lambda ──────────────────────────────────────────
    lambda_role = aws.iam.Role(
        'ctbk-avail-cascade-role', name='ctbk-avail-cascade-role',
        description='Execution role for ctbk avail cascade Lambdas',
        assume_role_policy=_assume('lambda.amazonaws.com'),
        opts=_imp('ctbk-avail-cascade-role'),
    )
    basic = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
    aws.iam.RolePolicyAttachment(
        'ctbk-avail-cascade-role-basic', role=lambda_role.name, policy_arn=basic,
        opts=_imp(f'ctbk-avail-cascade-role/{basic}'),
    )
    aws.cloudwatch.LogGroup(
        f'{LAMBDA}-logs', name=f'/aws/lambda/{LAMBDA}',
        opts=_imp(f'/aws/lambda/{LAMBDA}'),
    )
    fn = aws.lambda_.Function(
        LAMBDA, name=LAMBDA, role=lambda_role.arn, package_type='Image',
        image_uri=f'{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/ctbk-avail-lambda:rac-09fb47b9',
        architectures=['arm64'], memory_size=10240, timeout=900,
        ephemeral_storage={'size': 512},
        reserved_concurrent_executions=1,
        description='moved from RAC 006196295121 (image rac-09fb47b9)',
        opts=_imp(LAMBDA, ignore_changes=['environment', 'image_uri', 'description'],
                  additional_secret_outputs=['environment']),
    )
    for rule_name, (schedule, desc, config) in TICKS.items():
        rule = aws.cloudwatch.EventRule(
            rule_name, name=rule_name, schedule_expression=schedule, description=desc,
            state='ENABLED', opts=_imp(rule_name),
        )
        aws.cloudwatch.EventTarget(
            f'{rule_name}-target', rule=rule.name, target_id='fn', arn=fn.arn,
            input=json.dumps({'config': config}),
            opts=_imp(f'{rule_name}/fn'),
        )
        aws.lambda_.Permission(
            f'{rule_name}-invoke', function=fn.name, statement_id=f'invoke-{rule_name}',
            action='lambda:InvokeFunction', principal='events.amazonaws.com', source_arn=rule.arn,
            opts=_imp(f'{LAMBDA}/invoke-{rule_name}'),
        )

    # ── pyrmts-engine Batch ───────────────────────────────────────────
    exec_role = aws.iam.Role(
        'pyrmts-engine-batch-execution', name='pyrmts-engine-batch-execution',
        assume_role_policy=_assume('ecs-tasks.amazonaws.com'),
        opts=_imp('pyrmts-engine-batch-execution'),
    )
    ecs_exec = 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
    aws.iam.RolePolicyAttachment(
        'pyrmts-engine-batch-execution-ecs', role=exec_role.name, policy_arn=ecs_exec,
        opts=_imp(f'pyrmts-engine-batch-execution/{ecs_exec}'),
    )
    aws.cloudwatch.LogGroup(
        'pyrmts-engine-batch-logs', name='/pyrmts-engine/batch',
        opts=_imp('/pyrmts-engine/batch'),
    )
    ce = aws.batch.ComputeEnvironment(
        'pyrmts-engine-spot', name='pyrmts-engine-spot', type='MANAGED', state='ENABLED',
        compute_resources={
            'type': 'FARGATE_SPOT', 'max_vcpus': 16,
            'subnets': BATCH_SUBNETS, 'security_group_ids': [BATCH_SG],
        },
        opts=_imp('pyrmts-engine-spot'),
    )
    queue = aws.batch.JobQueue(
        'pyrmts-engine', name='pyrmts-engine', state='ENABLED', priority=1,
        compute_environment_orders=[{'order': 1, 'compute_environment': ce.arn}],
        opts=_imp(f'arn:aws:batch:{REGION}:{ACCOUNT}:job-queue/pyrmts-engine'),
    )

    # R2 creds for engine jobs (values set out-of-band).
    r2_secrets = [
        aws.secretsmanager.Secret(
            f'ctbk-r2-{part}', name=f'ctbk/r2-{part}',
            description=f'HCCS R2 RW {part} for pyrmts-engine Batch jobs (value set out-of-band)',
        )
        for part in ('access-key-id', 'secret-access-key')
    ]
    aws.iam.RolePolicy(
        'pyrmts-engine-batch-execution-r2-secrets', role=exec_role.name,
        policy=pulumi.Output.all(*[s.arn for s in r2_secrets]).apply(lambda arns: json.dumps({
            'Version': '2012-10-17',
            'Statement': [{'Effect': 'Allow', 'Action': 'secretsmanager:GetSecretValue', 'Resource': list(arns)}],
        })),
    )

    # ── GitHub Actions OIDC identity ──────────────────────────────────
    oidc = aws.iam.OpenIdConnectProvider(
        'github-actions', url='https://token.actions.githubusercontent.com',
        client_id_lists=['sts.amazonaws.com'],
    )
    gha = aws.iam.Role(
        'ctbk-gha', name='ctbk-gha',
        description=f'GitHub Actions ({GITHUB_REPO}) — Batch submit + read-only infra checks',
        assume_role_policy=oidc.arn.apply(lambda arn: json.dumps({
            'Version': '2012-10-17',
            'Statement': [{
                'Effect': 'Allow',
                'Principal': {'Federated': arn},
                'Action': 'sts:AssumeRoleWithWebIdentity',
                'Condition': {
                    'StringEquals': {'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com'},
                    'StringLike': {'token.actions.githubusercontent.com:sub': f'repo:{GITHUB_REPO}:*'},
                },
            }],
        })),
    )
    aws.iam.RolePolicy(
        'ctbk-gha-policy', role=gha.name,
        policy=pulumi.Output.all(queue.arn, exec_role.arn, fn.arn).apply(lambda a: json.dumps({
            'Version': '2012-10-17',
            'Statement': [
                {
                    'Sid': 'BatchSubmit',
                    'Effect': 'Allow',
                    'Action': ['batch:SubmitJob', 'batch:TagResource'],
                    'Resource': [a[0], f'arn:aws:batch:{REGION}:{ACCOUNT}:job-definition/pyrmts-engine*'],
                },
                {
                    'Sid': 'BatchRead',
                    'Effect': 'Allow',
                    'Action': ['batch:Describe*', 'batch:List*'],
                    'Resource': '*',
                },
                {
                    'Sid': 'BatchJobLogs',
                    'Effect': 'Allow',
                    'Action': ['logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:DescribeLogStreams'],
                    'Resource': f'arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/pyrmts-engine/batch:*',
                },
                {
                    'Sid': 'InfraDriftRead',
                    'Effect': 'Allow',
                    'Action': ['events:DescribeRule', 'events:ListTargetsByRule', 'events:ListRules',
                               'lambda:GetFunction', 'lambda:GetPolicy', 'lambda:GetFunctionConfiguration'],
                    'Resource': '*',
                },
            ],
        })),
    )
    pulumi.export('gha_role_arn', gha.arn)
    pulumi.export('r2_secret_arns', [s.arn for s in r2_secrets])
