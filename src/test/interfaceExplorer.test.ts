import * as assert from 'assert';
import { parseInterfaceTypes } from '../interfaces/interfaceExplorer';

suite('ROS 2 interface explorer', () => {
    test('parses message, service, and action interface types', () => {
        const output = [
            'std_msgs/msg/String',
            'example_interfaces/srv/AddTwoInts',
            'nav2_msgs/action/NavigateToPose'
        ].join('\n');

        assert.deepStrictEqual(parseInterfaceTypes(output), [
            'example_interfaces/srv/AddTwoInts',
            'nav2_msgs/action/NavigateToPose',
            'std_msgs/msg/String'
        ]);
    });

    test('removes duplicate and malformed interface names', () => {
        const output = [
            'std_msgs/msg/String',
            'std_msgs/msg/String',
            'not-an-interface',
            'bad package/msg/Type',
            'pkg/unknown/Type',
            'pkg/msg/Type;touch /tmp/file'
        ].join('\n');

        assert.deepStrictEqual(parseInterfaceTypes(output), ['std_msgs/msg/String']);
    });

    test('returns an empty list when no valid interfaces are present', () => {
        assert.deepStrictEqual(parseInterfaceTypes('ros2 interface list failed'), []);
    });
});
