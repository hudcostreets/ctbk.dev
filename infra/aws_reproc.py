"""AWS reproc-Batch infra for ctbk (pyrmts account 006196295121, us-east-1).

Extracted from `__main__.py` so CF-only stacks (e.g. the HCCS second copy) can
skip it via `manage_aws: false`. Full-DAG reproducibility-audit harness — see
specs/batch-reproc.md and specs/reproc-infra-separation.md. Namespaced
`ctbk-reproc-*` so nothing nj-crashes bootstraps against the shared `dvx.batch`
names can clobber it (dvx `3de35246c` added per-project `-P/--prefix`; these
names match its convention — role `<prefix>-batch-execution`, spot CE
`<prefix>-spot`, queue + job-def `<prefix>`, log group `/<prefix>/batch` — so
`dvx batch submit -P ctbk-reproc` targets this queue/job-def). The ECR repo and
the 3 secrets pre-exist and are referenced by ARN (values stay out of
Pulumi/state); the role, policy, log group, CE, queue and job def are created
here. Fargate networking (subnets/SG) copied from the live default-VPC
`dvx-spot` CE.
"""

import json
import pulumi
import pulumi_aws as aws

AWS_ACCOUNT = '006196295121'
AWS_REGION = 'us-east-1'
REPROC_IMAGE = f'{AWS_ACCOUNT}.dkr.ecr.{AWS_REGION}.amazonaws.com/ctbk-reproc:a6eef4b5'
REPROC_SUBNETS = [
    'subnet-0546ef24', 'subnet-860e7ccb', 'subnet-8300f6b2',
    'subnet-753e9d13', 'subnet-d8cf6087', 'subnet-bb7115b5',
]
REPROC_SG = 'sg-2053541d'
BATCH_SLR = f'arn:aws:iam::{AWS_ACCOUNT}:role/aws-service-role/batch.amazonaws.com/AWSServiceRoleForBatch'
REPROC_SECRETS = {
    'FARGATE_GITHUB_RW_TOKEN': f'arn:aws:secretsmanager:{AWS_REGION}:{AWS_ACCOUNT}:secret:ctbk-reproc/github-rw-token-97lSr8',
    'R2_ACCESS_KEY_ID':        f'arn:aws:secretsmanager:{AWS_REGION}:{AWS_ACCOUNT}:secret:ctbk-reproc/r2-access-key-id-TwMTmQ',
    'R2_SECRET_ACCESS_KEY':    f'arn:aws:secretsmanager:{AWS_REGION}:{AWS_ACCOUNT}:secret:ctbk-reproc/r2-secret-access-key-ws22nk',
}
REPROC_ENV = {
    'PYTHONFAULTHANDLER': '1',
    'REPROC_URL': 's3://ctbk/.reproc',
    'REPROC_ENDPOINT': 'https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com',
}


def provision():
    """Declare the AWS reproc Batch resources (RAC-side stacks only)."""
    # Provider pinned to the pyrmts account via the `r` profile (same creds the
    # aws-cli reproc pokes use); explicit so it doesn't depend on ambient AWS_PROFILE.
    aws_r = aws.Provider('pyrmts-reproc', profile='r', region=AWS_REGION)
    _awsopts = pulumi.ResourceOptions(provider=aws_r)

    reproc_exec_role = aws.iam.Role(
        'ctbk-reproc-batch-exec',
        name='ctbk-reproc-batch-execution',
        assume_role_policy=json.dumps({
            'Version': '2012-10-17',
            'Statement': [{
                'Effect': 'Allow',
                'Principal': {'Service': 'ecs-tasks.amazonaws.com'},
                'Action': 'sts:AssumeRole',
            }],
        }),
        opts=_awsopts,
    )

    aws.iam.RolePolicyAttachment(
        'ctbk-reproc-batch-exec-ecs',
        role=reproc_exec_role.name,
        policy_arn='arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
        opts=_awsopts,
    )

    aws.iam.RolePolicy(
        'ctbk-reproc-batch-secrets',
        name='ctbk-reproc-batch-secrets',
        role=reproc_exec_role.id,
        policy=json.dumps({
            'Version': '2012-10-17',
            'Statement': [{
                'Sid': 'CtbkReprocSecrets',
                'Effect': 'Allow',
                'Action': 'secretsmanager:GetSecretValue',
                'Resource': f'arn:aws:secretsmanager:{AWS_REGION}:{AWS_ACCOUNT}:secret:ctbk-reproc/*',
            }],
        }),
        opts=_awsopts,
    )

    reproc_log_group = aws.cloudwatch.LogGroup(
        'ctbk-reproc-batch-logs',
        name='/ctbk-reproc/batch',
        opts=_awsopts,
    )

    reproc_ce = aws.batch.ComputeEnvironment(
        'ctbk-reproc-spot',
        name='ctbk-reproc-spot',
        type='MANAGED',
        state='ENABLED',
        service_role=BATCH_SLR,
        compute_resources=aws.batch.ComputeEnvironmentComputeResourcesArgs(
            type='FARGATE_SPOT',
            max_vcpus=16,
            subnets=REPROC_SUBNETS,
            security_group_ids=[REPROC_SG],
        ),
        opts=_awsopts,
    )

    reproc_queue = aws.batch.JobQueue(
        'ctbk-reproc',
        name='ctbk-reproc',
        state='ENABLED',
        priority=1,
        compute_environment_orders=[aws.batch.JobQueueComputeEnvironmentOrderArgs(
            order=1,
            compute_environment=reproc_ce.arn,
        )],
        opts=_awsopts,
    )

    reproc_jobdef = aws.batch.JobDefinition(
        'ctbk-reproc',
        name='ctbk-reproc',
        type='container',
        platform_capabilities=['FARGATE'],
        container_properties=reproc_exec_role.arn.apply(lambda role_arn: json.dumps({
            'image': REPROC_IMAGE,
            'resourceRequirements': [
                {'type': 'VCPU', 'value': '16'},
                {'type': 'MEMORY', 'value': '65536'},
            ],
            'ephemeralStorage': {'sizeInGiB': 200},
            'executionRoleArn': role_arn,
            'runtimePlatform': {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'},
            'fargatePlatformConfiguration': {'platformVersion': 'LATEST'},
            # Public IP required for egress: the default-VPC subnets are public
            # (IGW route, no NAT), and a Fargate awsvpc ENI reaches the internet
            # (Secrets Manager / ECR / S3) only with a public IP — subnet
            # MapPublicIpOnLaunch does not apply to awsvpc ENIs. Without this the
            # task times out pulling secrets at init (matches live `dvx:41`).
            'networkConfiguration': {'assignPublicIp': 'ENABLED'},
            'secrets': [{'name': n, 'valueFrom': arn} for n, arn in REPROC_SECRETS.items()],
            'environment': [{'name': n, 'value': v} for n, v in REPROC_ENV.items()],
            'logConfiguration': {
                'logDriver': 'awslogs',
                'options': {'awslogs-group': '/ctbk-reproc/batch'},
            },
        })),
        opts=pulumi.ResourceOptions(provider=aws_r, depends_on=[reproc_log_group]),
    )

    pulumi.export('reproc_queue', reproc_queue.name)
    pulumi.export('reproc_job_definition', reproc_jobdef.arn)
    pulumi.export('reproc_image', REPROC_IMAGE)
