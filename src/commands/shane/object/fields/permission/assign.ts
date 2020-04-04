import { flags, SfdxCommand } from '@salesforce/command';
import chalk from 'chalk';
import { SfdxError, Connection } from '@salesforce/core';
import { RecordResult } from 'jsforce/record-result';
import { QueryResult, EntityParticle, FieldPermissions, User } from '../../../../../shared/typeDefs';

export default class PermsAssign extends SfdxCommand {
    public static description = 'align profiles with ';

    public static examples = [`Dummy`];

    protected static flagsConfig = {
        object: flags.string({ required: true, char: 'o', description: 'Object API Name' }),
        permission: flags.string({ required: true, char: 'p', description: '"Read" or "Edit" permission' }),
        fieldname: flags.string({ required: true, char: 'f', description: 'Field API Name' })
    };

    protected static requiresProject = false;

    protected static requiresUsername = true;

    public async run(): Promise<any> {
        this.validatePermissionRequestedByUser();

        const conn = await this.org.getConnection();

        const fieldMetadata: EntityParticle = await this.queryFieldMetadata(conn);

        if (!fieldMetadata.IsPermissionable) {
            throw new SfdxError(`${this.flags.object}.${this.flags.fieldname} is not permissable`);
        }

        if (!fieldMetadata.IsUpdatable && this.flags.permission.toUpperCase() === 'EDIT') {
            throw new SfdxError(`${this.flags.object}.${this.flags.fieldname} is not updatable, so Edit permission cannot be granted`);
        }

        const profileId = await this.getUserProfileId(conn);
        const profilePermissionSetId = await PermsAssign.getPermissionSetIdForProfileId(conn, profileId);

        const existingPermissionRecords = await this.queryExistingPermissionRecords(conn, profilePermissionSetId);

        existingPermissionRecords.forEach(recorObj => {
            if (this.flags.permission.toUpperCase() === 'READ' && recorObj.PermissionsRead) {
                throw new SfdxError(`${this.flags.permission} access already exists for field: ${this.flags.object}.${this.flags.fieldname}`);
            }
            if (this.flags.permission.toUpperCase() === 'EDIT' && recorObj.PermissionsEdit) {
                throw new SfdxError(`${this.flags.permission} access already exists for field: ${this.flags.object}.${this.flags.fieldname}`);
            }
        });

        if (this.flags.permission.toUpperCase() === 'READ') {
            await this.assignReadPermission(conn, profilePermissionSetId);
        }

        if (this.flags.permission.toUpperCase() === 'EDIT') {
            await this.assignEditPermission(conn, existingPermissionRecords, profilePermissionSetId);
        }
    }

    private async insertPermissionRecord(conn: Connection, permissionRecordToInsert: FieldPermissions): Promise<void> {
        const resultObj = await conn.sobject('FieldPermissions').create(permissionRecordToInsert);
        this.processResults(resultObj);
    }

    private async updatePermissionRecord(conn: Connection, permissionRecordToUpsert: FieldPermissions): Promise<void> {
        const resultObj: RecordResult = await conn.sobject('FieldPermissions').update(permissionRecordToUpsert);
        this.processResults(resultObj);
    }

    private processResults(results: RecordResult): void {
        let failed: boolean;
        let errorMessages: string;
        if (Array.isArray(results)) {
            results.forEach(element => {
                if (!element.success) {
                    failed = true;
                    element.errors.forEach(innerElem => {
                        errorMessages += innerElem.message;
                    });
                }
            });
        }

        if (failed) {
            this.ux.log(chalk.red(errorMessages));
        } else {
            this.ux.log(chalk.green(`Executed Successfully!`));
        }
    }

    // queries either rest or tooling api to find the ids needed. Returns the id as a string
    private async queryExistingPermissionRecords(conn: Connection, profilePermissionSetId: string): Promise<FieldPermissions[]> {
        const queryStr = `SELECT Id,Field,SobjectType,PermissionsRead,PermissionsEdit FROM FieldPermissions WHERE ParentId='${profilePermissionSetId}' AND SobjectType = '${this.flags.object}' AND Field='${this.flags.object}.${this.flags.fieldname}' `;

        const fieldPermissionRecords = (await conn.query(queryStr)).records as FieldPermissions[];

        return fieldPermissionRecords;
    }

    // returns if field is permissionable or not.
    private async queryFieldMetadata(conn: Connection): Promise<EntityParticle> {
        // If field API Name is "Foo__c" but if user enters field api name as "foo__c", query is not finding the record.
        // So, had to use LIKE condition.
        const queryStr = `SELECT   IsPermissionable,
                                    QualifiedApiName,
                                    IsUpdatable
                            FROM    EntityParticle 
                            WHERE   EntityDefinition.QualifiedApiName = '${this.flags.object}'
                            AND     QualifiedApiName LIKE '${this.flags.fieldname}'`;
        const queryResult = (await conn.tooling.query(queryStr)).records as EntityParticle[];
        let recordObjToReturn: EntityParticle;

        // Field API name in database and what user entered may not match, so we have to bring both to common case and compare.
        queryResult.forEach(recordObj => {
            if (recordObj.QualifiedApiName.toUpperCase() === this.flags.fieldname.toUpperCase()) {
                recordObjToReturn = recordObj;
            }
        });
        if (recordObjToReturn === undefined) {
            throw new SfdxError(`Field "${this.flags.fieldname}" is not found on Object "${this.flags.object}".`);
        }
        return recordObjToReturn;
    }

    private static readPermissionAlreadyExistsForSameField(existingPermissionRecords: FieldPermissions[]): boolean {
        let readPermissionExists = false;
        existingPermissionRecords.forEach(recorObj => {
            if (recorObj.PermissionsRead) {
                readPermissionExists = true;
            }
        });
        return readPermissionExists;
    }

    private async getUserProfileId(conn: Connection): Promise<string> {
        const userRecords = (await conn.query(`SELECT Id,ProfileId FROM User WHERE username='${this.org.getUsername()}' LIMIT 1`)).records as User[];
        if (userRecords.length === 0) {
            throw new SfdxError('Username not found.');
        }
        return userRecords[0].ProfileId;
    }

    private validatePermissionRequestedByUser(): void {
        if (this.flags.permission.toUpperCase() !== 'READ' && this.flags.permission.toUpperCase() !== 'EDIT') {
            throw new SfdxError(`Permission requested should be either 'Read' or 'Edit'`);
        }
    }

    public static async getPermissionSetIdForProfileId(conn: Connection, profileId: string): Promise<string> {
        const permissionsetRecords: QueryResult = await conn.query(`SELECT Id FROM PermissionSet WHERE ProfileId='${profileId}'`);
        if (permissionsetRecords.records.length === 0) {
            throw new SfdxError('Something went wrong!');
        }
        return permissionsetRecords.records[0].Id;
    }

    private async assignEditPermission(
        conn: Connection,
        existingPermissionRecords: FieldPermissions[],
        profilePermissionSetId: string
    ): Promise<void> {
        if (this.flags.permission.toUpperCase() === 'EDIT') {
            let permissionRecordToUpdate: FieldPermissions;
            const readPermissionExists = PermsAssign.readPermissionAlreadyExistsForSameField(existingPermissionRecords);
            if (readPermissionExists) {
                existingPermissionRecords.forEach(recorObj => {
                    if (this.flags.permission.toUpperCase() === 'EDIT' && recorObj.PermissionsRead) {
                        permissionRecordToUpdate = recorObj;
                        permissionRecordToUpdate.PermissionsEdit = true;
                    }
                });
                await this.updatePermissionRecord(conn, permissionRecordToUpdate);
            } else {
                const permissionRecordToInsert: FieldPermissions = {
                    PermissionsEdit: true,
                    PermissionsRead: true,
                    SobjectType: this.flags.object,
                    Field: `${this.flags.object}.${this.flags.fieldname}`,
                    ParentId: profilePermissionSetId,
                    Id: undefined
                };
                await this.insertPermissionRecord(conn, permissionRecordToInsert);
            }
        }
    }

    private async assignReadPermission(conn: Connection, profilePermissionSetId: string): Promise<void> {
        const permissionRecordToInsert: FieldPermissions = {
            PermissionsEdit: false,
            PermissionsRead: true,
            SobjectType: this.flags.object,
            Field: `${this.flags.object}.${this.flags.fieldname}`,
            ParentId: profilePermissionSetId,
            Id: undefined
        };
        await this.insertPermissionRecord(conn, permissionRecordToInsert);
    }
}
