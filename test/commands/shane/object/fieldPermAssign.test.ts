import { exec } from '../../../../src/shared/execProm';

import fs = require('fs-extra');
import testutils = require('../../../helpers/testutils');

const testProjectName = 'testProjectFieldPermissionAssign';

describe('shane:object:fields:permission:assign', () => {
    jest.setTimeout(testutils.localTimeout);

    beforeAll(async () => {
        await fs.remove(testProjectName);
        await exec(`sfdx force:project:create -n ${testProjectName}`);
        await testutils.orgCreate(testProjectName);
    });

    it('Creates custom field and assigns permission', async () => {
        await exec(`sfdx force:source:retrieve --metadata=CustomObject:Account`, { cwd: testProjectName });
        expect(fs.existsSync(`${testProjectName}/force-app/main/default/objects/Account`)).toBe(true);
        await exec(`sfdx shane:object:field --api=Foo__c --object=Account --name=Foo --type=Text --length=255`, { cwd: testProjectName });
        await exec(`sfdx shane:object:field --api=Bar__c --object=Account --name=Bar --type=Text --length=255`, { cwd: testProjectName });
        expect(fs.existsSync(`${testProjectName}/force-app/main/default/objects/Account`)).toBe(true);
        expect(fs.existsSync(`${testProjectName}/force-app/main/default/objects/Account/fields`)).toBe(true);
        expect(fs.existsSync(`${testProjectName}/force-app/main/default/objects/Account/fields/Foo__c.field-meta.xml`)).toBe(true);
        await exec(`sfdx force:source:push`, { cwd: testProjectName });
        await exec(`sfdx shane:object:fields:permission:assign --object Account --permission read --fieldname Foo__c`, { cwd: testProjectName });
        await exec(`sfdx force:source:retrieve --metadata=Profile:Admin`, { cwd: testProjectName });

        const parsed = await testutils.getParsedXML(`${testProjectName}/force-app/main/default/profiles/Admin.profile-meta.xml`);
        parsed.Profile.fieldPermissions.forEach(element => {
            if (element.field == 'Account.Foo__c') {
                expect(element.readable).toBe('true');
            }
            if (element.field == 'Account.Bar__c') {
                expect(element.readable).toBe('false');
            }
        });
    }, 300000);

    afterAll(async () => {
        await testutils.orgDelete(testProjectName);
        await fs.remove(testProjectName);
    });
});
