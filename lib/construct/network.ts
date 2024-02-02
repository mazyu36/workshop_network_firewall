import { Construct } from 'constructs';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { aws_elasticloadbalancingv2 as elbv2 } from 'aws-cdk-lib';
import { aws_elasticloadbalancingv2_targets as targets } from 'aws-cdk-lib';
import { aws_networkfirewall as networkfirewall } from 'aws-cdk-lib';
import * as cdk from "aws-cdk-lib";
import { aws_logs as logs } from 'aws-cdk-lib';

export interface NetworkConstructProps {

}

export class NetworkConstruct extends Construct {
  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);


    // ------ Service VPC -------
    const vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
      natGateways: 1,
      maxAzs: 1,
      subnetConfiguration: [
        {
          cidrMask: 28,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 28,
          name: 'FirewallSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'ProtectedWorkloadSubnet',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    }
    )


    const userData = ec2.UserData.forLinux({ shebang: '#!/bin/bash' })
    userData.addCommands(
      '#!/bin/bash',
      'sudo dnf install nginx -y',
      'sudo systemctl enable nginx',
      'sudo systemctl start nginx',
    )

    // ----- EC2インスタンスを作成 ---
    const ec2Instance = new ec2.Instance(this, 'Ec2Instance', {
      vpc: vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
        cpuType: ec2.AmazonLinuxCpuType.X86_64
      }),
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }),
      ssmSessionPermissions: true,
      userData: userData
    });


    // ------ NLB ------
    const nlb = new elbv2.NetworkLoadBalancer(this, 'NLB', {
      vpc: vpc,
      internetFacing: true,
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }),

    })

    const nlbSg = new ec2.SecurityGroup(this, 'NlbSecurityGroup', {
      vpc: vpc
    })

    nlbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80))
    nlbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.icmpPing())


    nlb.addSecurityGroup(nlbSg)

    const listener = nlb.addListener('Listener', {
      port: 80,
    })

    listener.addTargets('ServiceInstance', {
      port: 80,
      targets: [new targets.InstanceTarget(ec2Instance)],
      protocol: elbv2.Protocol.TCP,
      preserveClientIp: true
    })

    ec2Instance.connections.allowFrom(nlb, ec2.Port.tcp(80))
    ec2Instance.connections.allowFrom(nlb, ec2.Port.icmpPing())



    // -------- Network Firewall ------
    const amazonDomainRuleGroup = new networkfirewall.CfnRuleGroup(this, 'AmazonDomainRuleGroup', {
      capacity: 10,
      description: 'Allow Access to AWS services',
      ruleGroupName: 'AllowAmazonDomains',
      type: 'STATEFUL',
      ruleGroup: {
        statefulRuleOptions: {
          ruleOrder: 'STRICT_ORDER'
        },
        rulesSource: {
          rulesSourceList: {
            generatedRulesType: 'ALLOWLIST',
            targets: ['.amazonaws.com', '.amazon.com'],
            targetTypes: ['TLS_SNI', 'HTTP_HOST']
          }
        }
      }

    })


    const httpPortRuleGroup = new networkfirewall.CfnRuleGroup(this, 'HttpPortRuleGroup', {
      capacity: 10,
      description: 'Allow Access to EC2 instance on port 80',
      ruleGroupName: 'AllowPort80',
      type: 'STATEFUL',
      ruleGroup: {
        statefulRuleOptions: {
          ruleOrder: 'STRICT_ORDER'
        },
        rulesSource: {
          statefulRules: [{
            action: 'PASS',
            header: {
              destination: vpc.isolatedSubnets[0].ipv4CidrBlock,
              destinationPort: '80',
              protocol: 'HTTP',
              direction: 'FORWARD',
              source: 'ANY',
              sourcePort: 'ANY'
            },
            ruleOptions: [
              { keyword: 'sid: 11111' }
            ]
          }]

        }
      }
    })



    const statelessRuleGroup = new networkfirewall.CfnRuleGroup(this, 'StatelessRuleGroup', {
      capacity: 100,
      ruleGroupName: 'allow-80-443-icmp',
      type: 'STATELESS',
      ruleGroup: {
        rulesSource: {
          statelessRulesAndCustomActions: {
            statelessRules: [{
              priority: 1,
              ruleDefinition: {
                actions: ['aws:pass'],
                matchAttributes: {
                  destinationPorts: [{
                    fromPort: 80,
                    toPort: 80,
                  },
                  {
                    fromPort: 443,
                    toPort: 443,
                  }],
                  destinations: [{
                    addressDefinition: '0.0.0.0/0',
                  }],
                  sourcePorts: [{
                    fromPort: 0,
                    toPort: 65535,
                  }],
                  sources: [{
                    addressDefinition: '0.0.0.0/0',
                  }],
                  protocols: [6]
                },
              },
            },
            {
              priority: 2,
              ruleDefinition: {
                actions: ['aws:pass'],
                matchAttributes: {
                  destinationPorts: [{
                    fromPort: 0,
                    toPort: 65535,
                  }],
                  destinations: [{
                    addressDefinition: '0.0.0.0/0',
                  }],
                  sourcePorts: [{
                    fromPort: 80,
                    toPort: 80,
                  },
                  {
                    fromPort: 443,
                    toPort: 443,
                  }],
                  sources: [{
                    addressDefinition: '0.0.0.0/0',
                  }],
                  protocols: [6]

                },
              },
            },
            {
              priority: 3,
              ruleDefinition: {
                actions: ['aws:forward_to_sfe'],
                matchAttributes: {
                  destinations: [{
                    addressDefinition: '0.0.0.0/0',
                  }],
                  sources: [{
                    addressDefinition: '0.0.0.0/0',
                  }],
                  protocols: [17]
                },
              },
            }
            ],


          }
        }
      }
    })



    const statefulIpsRuleGroup = new networkfirewall.CfnRuleGroup(this, 'StatefulIpsRuleGroup', {
      capacity: 100,
      ruleGroupName: 'suricata-ips',
      type: 'STATEFUL',
      ruleGroup: {
        statefulRuleOptions: {
          ruleOrder: 'STRICT_ORDER'
        },
        rulesSource: {
          rulesString: `alert icmp any any -> any any (msg:"ICMP traffic detected"; flow:to_server; sid: 889;)`,
        }
      }
    })



    const firewallPolicy = new networkfirewall.CfnFirewallPolicy(this, 'FirewallPolicy', {
      firewallPolicyName: 'ANFW-Lab-Policy',
      firewallPolicy: {
        statefulRuleGroupReferences: [
          {
            priority: 1,
            resourceArn: amazonDomainRuleGroup.attrRuleGroupArn
          },
          {
            priority: 2,
            resourceArn: httpPortRuleGroup.attrRuleGroupArn
          },
          {
            priority: 3,
            resourceArn: statefulIpsRuleGroup.attrRuleGroupArn
          },
        ],
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulDefaultActions: ['aws:drop_established'],
        statefulEngineOptions: {
          ruleOrder: 'STRICT_ORDER'
        },
        statelessRuleGroupReferences: [{
          priority: 1,
          resourceArn: statelessRuleGroup.attrRuleGroupArn
        }]
      }
    })
    firewallPolicy.addDependency(amazonDomainRuleGroup)
    firewallPolicy.addDependency(httpPortRuleGroup)
    firewallPolicy.addDependency(statelessRuleGroup)
    firewallPolicy.addDependency(statefulIpsRuleGroup)


    const firewall = new networkfirewall.CfnFirewall(this, 'Firewall', {
      firewallName: 'ANFW-Lab',
      vpcId: vpc.vpcId,
      firewallPolicyArn: firewallPolicy.attrFirewallPolicyArn,
      subnetMappings: [{
        subnetId: vpc.privateSubnets[0].subnetId,
        ipAddressType: 'IPV4'
      }]
    })
    firewall.addDependency(firewallPolicy)


    const cwLogs = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: 'anfw_lab',
      retention: logs.RetentionDays.ONE_DAY,
      logGroupClass: logs.LogGroupClass.STANDARD,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    const cfnLoggingConfiguration = new networkfirewall.CfnLoggingConfiguration(this, 'CfnLoggingConfiguration', {
      firewallArn: firewall.attrFirewallArn,
      loggingConfiguration: {
        logDestinationConfigs: [
          {
            logDestination: {
              "logGroup": cwLogs.logGroupName
            },
            logDestinationType: 'CloudWatchLogs',
            logType: 'ALERT',
          },
          {
            logDestination: {
              "logGroup": cwLogs.logGroupName
            },
            logDestinationType: 'CloudWatchLogs',
            logType: 'FLOW',
          }
        ],
      },
    });
    cfnLoggingConfiguration.addDependency(firewall)
    cfnLoggingConfiguration.node.addDependency(cwLogs)

    // // Routing NAT GW to Network Firewall
    // vpc
    //   .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
    //   .subnets.forEach((subnet, index) => {
    //     const route = subnet.node.children.find(
    //       (child) => child.node.id == "DefaultRoute"
    //     ) as ec2.CfnRoute;
    //     route.addDeletionOverride("Properties.GatewayId");
    //     route.addOverride(
    //       "Properties.VpcEndpointId",
    //       cdk.Fn.select(
    //         1,
    //         cdk.Fn.split(
    //           ":",
    //           cdk.Fn.select(index, firewall.attrEndpointIds)
    //         )
    //       )
    //     );
    //   });


    new ec2.CfnRoute(this, 'Public Subnet to Network Firewall', {
      routeTableId: vpc.publicSubnets[0].routeTable.routeTableId,
      destinationCidrBlock: vpc.isolatedSubnets[0].ipv4CidrBlock,
      vpcEndpointId: cdk.Fn.select(
        1,
        cdk.Fn.split(
          ":",
          cdk.Fn.select(0, firewall.attrEndpointIds)
        )
      ),
    });


    new ec2.CfnRoute(this, 'Isolated Subnet to Network Firewall', {
      routeTableId: vpc.isolatedSubnets[0].routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      vpcEndpointId: cdk.Fn.select(
        1,
        cdk.Fn.split(
          ":",
          cdk.Fn.select(0, firewall.attrEndpointIds)
        )
      ),
    });


    // vpc
    //   .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED })
    //   .subnets.forEach((subnet, index) => {
    //     new ec2.CfnRoute(
    //       this,
    //       `NatGwRouteTableToFirewall${index}`,
    //       {
    //         routeTableId: subnet.routeTable.routeTableId,
    //         destinationCidrBlock: '0.0.0.0/0',
    //         vpcEndpointId: cdk.Fn.select(
    //           1,
    //           cdk.Fn.split(
    //             ":",
    //             cdk.Fn.select(index, firewall.attrEndpointIds)
    //           )
    //         ),
    //       }
    //     );
    //   });



    // // // Routing Network Firewall to Internet Gateway
    // // vpc
    // //   .selectSubnets({ subnetType: ec2.SubnetType.PUBLIC })
    // //   .subnets.forEach((subnet, index) => {
    // //     const route = subnet.node.children.find(
    // //       (child) => child.node.id == "DefaultRoute"
    // //     ) as ec2.CfnRoute;
    // //     route.addDeletionOverride("Properties.NatGatewayId");
    // //     route.addOverride("Properties.GatewayId", vpc.internetGatewayId);
    // //   });

    // // Internet Gateway RouteTable
    // const igwRouteTable = new ec2.CfnRouteTable(this, "IgwRouteTable", {
    //   vpcId: vpc.vpcId,
    // });

    // // Routing Internet Gateway to Network Firewall
    // vpc
    //   .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
    //   .subnets.forEach((subnet, index) => {
    //     new ec2.CfnRoute(
    //       this,
    //       `IgwRouteTableToFirewall${index}`,
    //       {
    //         routeTableId: igwRouteTable.ref,
    //         destinationCidrBlock: subnet.ipv4CidrBlock,
    //         vpcEndpointId: cdk.Fn.select(
    //           1,
    //           cdk.Fn.split(
    //             ":",
    //             cdk.Fn.select(index, firewall.attrEndpointIds)
    //           )
    //         ),
    //       }
    //     );
    //   });

    // // Association Internet Gateway RouteTable
    // new ec2.CfnGatewayRouteTableAssociation(this, "IgwRouteTableAssociation", {
    //   gatewayId: <string>vpc.internetGatewayId,
    //   routeTableId: igwRouteTable.ref,
    // });

  }
}