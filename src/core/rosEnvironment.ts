import * as path from 'path';
import { existsSync } from 'fs';

/** Owns the single active ROS 2 environment used by all extension features. */
export class RosEnvironmentManager {
    private configuredSetup = '';
    get setupCommand(): string {
        if (!this.configuredSetup) {
            throw new Error('ROS environment has not been configured.');
        }
        return this.configuredSetup;
    }
    get isConfigured(): boolean { return this.configuredSetup.length > 0; }

    configure(distro: string, domainId: number, inheritedEnvironment: NodeJS.ProcessEnv = process.env): void {
        if (!/^[a-z][a-z0-9_]*$/.test(distro) || !existsSync(path.join('/opt/ros', distro, 'setup.bash'))) {
            throw new Error(`ROS 2 distribution "${distro}" is not installed or has an invalid name.`);
        }
        if (!Number.isInteger(domainId) || domainId < 0 || domainId > 232) {
            throw new Error('ROS_DOMAIN_ID must be an integer between 0 and 232.');
        }
        const inheritedRmw = inheritedEnvironment.RMW_IMPLEMENTATION;
        const rmwImplementation = inheritedRmw && /^rmw_[A-Za-z0-9_]+$/.test(inheritedRmw)
            ? inheritedRmw : 'rmw_cyclonedds_cpp';
        this.configuredSetup = [
            `source /opt/ros/${distro}/setup.bash`,
            `export ROS_DOMAIN_ID=${domainId}`,
            `export RMW_IMPLEMENTATION=${rmwImplementation}`
        ].join(' && ');
    }
    withEnvironment(command: string): string {
        if (!command.trim()) {
            throw new Error('ROS command cannot be empty.');
        }
        return `${this.setupCommand} && ${command}`;
    }
}
export const rosEnvironment = new RosEnvironmentManager();