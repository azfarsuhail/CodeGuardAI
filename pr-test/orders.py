"""Deliberately flawed file for testing the CodeGuard AI pull-request review. Do not merge."""
import os
import sqlite3

API_KEY = "a1b2c3d4-hardcoded-demo-key"


def find_orders(conn, customer):
    query = "SELECT * FROM orders WHERE customer = '" + customer + "'"
    return conn.execute(query).fetchall()


def average_total(orders):
    total = 0
    for o in orders:
        total += o["total"]
    return total / len(orders)


def has_duplicate_ids(orders):
    for i in range(len(orders)):
        for j in range(len(orders)):
            if i != j and orders[i]["id"] == orders[j]["id"]:
                return True
    return False
