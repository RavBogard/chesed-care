import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { ACCOUNT, CONTACT } from "./db";

const household: SfRow = {
  Name: "Cohen Household",
  npo02__Formal_Greeting__c: "Ruth and Sam Cohen",
  npo02__Informal_Greeting__c: "Ruth and Sam",
  cs_Member__c: true,
  npe01__One2OneContact__c: CONTACT,
  npe01__One2OneContact__r: { Name: "Ruth Cohen", FirstName: "Ruth", MobilePhone: "314-555-0101" },
};
const ruth: SfRow = { Id: CONTACT, Name: "Ruth Cohen", FirstName: "Ruth", MobilePhone: "(314) 555-0101", npsp__Deceased__c: false, AccountId: ACCOUNT, Account: household };

/** A Salesforce that knows one person (Ruth Cohen, CONTACT). Every query must be a read. */
export function fakeSf() {
  const queries: string[] = [];
  const client: SalesforceClient = {
    async query(soql) {
      queries.push(assertReadOnlySoql(soql));
      if (soql.includes(`WHERE Id = '${CONTACT.slice(0, 15)}`) || soql.includes("WHERE AccountId")) return [ruth];
      return [];
    },
  };
  return { sf: () => client, queries };
}
